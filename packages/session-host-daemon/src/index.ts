/**
 * Session-host daemon entrypoint.
 *
 * Roles:
 * - Owns the local harness fleet (Pi / Claude Code / Hermes).
 * - Speaks the adapter-protocol back to the cloud orchestrator over the relay
 *   (AdapterProtocolServer).
 * - Hosts the local REST API the mobile app uses for monitors / tmux / health.
 * - Runs the Hermes bridges (jobs polling + webhook + skills) when applicable.
 * - Runs the local scheduler when in non-Hermes mode.
 *
 * No voice code lives here. STT, TTS, VAD, smart-turn, inference gate are all
 * in the cloud orchestrator (pipecat/).
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { loadConfig } from "./config.js";
import { makeHarness } from "./harness/index.js";
import { getCapabilities } from "./harness/capabilities.js";
import { listProviders } from "./harness/providers/index.js";
import {
  describeSyncResult,
  syncOverwatchSkill,
} from "./harness/skill-installer.js";
import { createMonitorsRouter } from "./routes/monitors.js";
import { createTmuxRouter } from "./routes/tmux.js";
import { createHermesWebhookRouter } from "./scheduler/hermes-webhook.js";
import { HermesJobsBridge } from "./scheduler/hermes-jobs-bridge.js";
import { LocalMonitorSource } from "./scheduler/local-monitor-source.js";
import { HermesSkillsBridge } from "./scheduler/hermes-skills-bridge.js";
import {
  listJobRuns,
  readJobRunOutput,
  summarizeOutput,
} from "./scheduler/hermes-job-runs.js";
import { notificationStore } from "./notifications/store.js";
import { AdapterProtocolServer } from "./adapter-protocol/index.js";
import type { OrchestratorHarness } from "./harness/types.js";
import type { MonitorSource } from "./scheduler/monitor-source.js";

const config = loadConfig();

if (config.HARNESS_PROVIDER === "hermes") {
  try {
    const result = await syncOverwatchSkill({ skillName: config.HERMES_SKILL_NAME });
    console.log(describeSyncResult(result));
  } catch (err) {
    console.warn(
      `[hermes] skill sync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const harness: OrchestratorHarness = makeHarness({
  provider: config.HARNESS_PROVIDER,
  hermes:
    config.HARNESS_PROVIDER === "hermes"
      ? {
          baseURL: config.HERMES_BASE_URL,
          apiKey: config.HERMES_API_KEY,
          sessionId: config.HERMES_SESSION_ID,
          skillName: config.HERMES_SKILL_NAME,
          isVoice: true,
        }
      : undefined,
});

// Register the harness under both its provider id (e.g. "claude-code") and
// the configured selector (e.g. "claude-code-cli") so commands targeting
// either name resolve correctly.
const harnesses: Record<string, OrchestratorHarness> = {
  [harness.provider]: harness,
  [config.HARNESS_PROVIDER]: harness,
};

let hermesJobsBridge: HermesJobsBridge | null = null;
let hermesSkillsBridge: HermesSkillsBridge | null = null;
let monitorSource: MonitorSource;

if (config.HARNESS_PROVIDER === "hermes") {
  hermesJobsBridge = new HermesJobsBridge({
    baseURL: config.HERMES_BASE_URL,
    apiKey: config.HERMES_API_KEY,
    onJobFired: async (job, prevLastRunAt) => {
      const status = job.last_status ?? "ok";
      const errMsg = job.last_error ?? null;
      try {
        if (status === "error" || errMsg) {
          notificationStore.create({
            kind: "scheduled_task_error",
            title: `${job.name} failed`,
            body: errMsg ?? "Job failed",
            speakableText: `${job.name} failed. ${errMsg ?? ""}`.trim(),
            source: { type: "scheduler", id: job.id },
            metadata: { jobId: job.id, prevLastRunAt, source: "hermes-poll" },
          });
          return;
        }
        const runs = await listJobRuns(job.id);
        const newest = runs[0];
        let summary = `${job.name} completed.`;
        if (newest) {
          const content = await readJobRunOutput(job.id, newest.id);
          if (content) summary = summarizeOutput(content);
        }
        notificationStore.create({
          kind: "scheduled_task_result",
          title: `${job.name} completed`,
          body: summary,
          speakableText: summary,
          source: { type: "scheduler", id: job.id },
          metadata: {
            jobId: job.id,
            prevLastRunAt,
            source: "hermes-poll",
            runId: newest?.id,
          },
        });
      } catch (err) {
        console.warn(
          `[hermes-jobs] notification creation failed for ${job.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  });
  monitorSource = hermesJobsBridge;
  hermesSkillsBridge = new HermesSkillsBridge();
} else {
  monitorSource = new LocalMonitorSource();
}

// Mark monitorSource as used (the variable is assigned to drive the routes mount below).
void monitorSource;

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    harness: config.HARNESS_PROVIDER,
    capabilities: getCapabilities(config.HARNESS_PROVIDER),
    providers: listProviders(),
    voice: "cloud-orchestrator",
    relay_url: config.RELAY_URL,
    hermes:
      config.HARNESS_PROVIDER === "hermes"
        ? { baseURL: config.HERMES_BASE_URL, sessionId: config.HERMES_SESSION_ID }
        : undefined,
  }),
);

app.get("/debug/harness", async (c) => {
  const prompt = c.req.query("prompt") ?? "Reply with exactly one short line.";
  const events: unknown[] = [];
  for await (const event of harness.runTurn({
    prompt,
    correlation_id: "debug-" + Date.now(),
  })) {
    events.push(event);
  }
  return c.json({ provider: config.HARNESS_PROVIDER, events });
});

app.route(
  "/api/v1/monitors",
  createMonitorsRouter({
    harnessProvider: config.HARNESS_PROVIDER,
    hermesBaseURL: config.HERMES_BASE_URL,
    hermesApiKey: config.HERMES_API_KEY,
    hermesJobsBridge,
  }),
);

app.route("/api/v1/hermes/webhook", createHermesWebhookRouter());

app.route(
  "/api/v1/tmux",
  createTmuxRouter({
    authToken: process.env.OVERWATCH_API_TOKEN || undefined,
    bindHost: config.OVERWATCH_LISTEN_HOST,
  }),
);

console.log(
  `[daemon] starting on http://${config.OVERWATCH_LISTEN_HOST}:${config.PORT}`,
);
if (config.OVERWATCH_LISTEN_HOST !== "127.0.0.1" && !process.env.OVERWATCH_API_TOKEN) {
  console.warn(
    "[daemon] WARNING: OVERWATCH_LISTEN_HOST is not loopback and " +
      "OVERWATCH_API_TOKEN is unset — /api/v1/tmux mutating endpoints are " +
      "unauthenticated. Anyone reachable on the network can spawn tmux " +
      "sessions and inject keystrokes. Set OVERWATCH_API_TOKEN immediately.",
  );
}

const server = serve(
  {
    fetch: app.fetch,
    port: config.PORT,
    hostname: config.OVERWATCH_LISTEN_HOST,
  },
  (info) => {
    console.log(`[daemon] listening on http://${info.address}:${info.port}`);
  },
);

// Suppress unused warning for `server` — kept so we have a handle to it for
// future shutdown handling.
void server;

const adapterServer = new AdapterProtocolServer({
  deps: {
    relayUrl: config.RELAY_URL,
    userId: config.OVERWATCH_USER_ID,
    pairingToken: config.ORCHESTRATOR_PAIRING_TOKEN,
    sessionTokenSecret: config.ORCHESTRATOR_PAIRING_TOKEN,
    auditLogPath: config.AUDIT_LOG_PATH,
    catchAllLoggerEnabled: config.CATCH_ALL_LOGGER,
  },
  harnesses,
  activeProviderId: config.HARNESS_PROVIDER,
  activeTarget: harness.provider,
  monitorSource,
  hermesJobsBridge,
  hermesSkillsBridge,
  hermesBaseURL: config.HERMES_BASE_URL,
  hermesApiKey: config.HERMES_API_KEY,
});

if (config.OVERWATCH_USER_ID && config.ORCHESTRATOR_PAIRING_TOKEN) {
  adapterServer.start();
  console.log(
    `[adapter-protocol] connecting to ${config.RELAY_URL} as user ${config.OVERWATCH_USER_ID}`,
  );
} else {
  console.warn(
    "[adapter-protocol] OVERWATCH_USER_ID/ORCHESTRATOR_PAIRING_TOKEN not set; daemon will not connect to cloud orchestrator. Run `overwatch setup` to pair.",
  );
}

if (config.HARNESS_PROVIDER === "hermes") {
  hermesJobsBridge?.start();
  hermesSkillsBridge?.start();
  console.log("[hermes] mode active");
} else {
  // Local scheduler runner is no longer wired here — local cron has been
  // replaced by the orchestrator's idle_report and harness adapters surface
  // their own scheduling. Local monitor source still serves /api/v1/monitors.
}

const shutdown = () => {
  console.log("[daemon] shutting down");
  adapterServer.stop();
  hermesJobsBridge?.stop();
  hermesSkillsBridge?.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

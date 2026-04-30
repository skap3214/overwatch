import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
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
import { DeepgramSttAdapter } from "./stt/deepgram.js";
import { DeepgramTtsAdapter } from "./tts/deepgram.js";
import { TurnCoordinator } from "./orchestrator/turn-coordinator.js";
import { createSttHandler } from "./routes/stt.js";
import { createMonitorsRouter } from "./routes/monitors.js";
import { createTmuxRouter } from "./routes/tmux.js";
import { attachRealtimeServer } from "./realtime/socket-server.js";
import { SchedulerRunner } from "./tasks/scheduler-runner.js";
import { HermesJobsBridge } from "./scheduler/hermes-jobs-bridge.js";
import { LocalMonitorSource } from "./scheduler/local-monitor-source.js";
import type { MonitorSource } from "./scheduler/monitor-source.js";
import { createHermesWebhookRouter } from "./scheduler/hermes-webhook.js";
import { listJobRuns, readJobRunOutput, summarizeOutput } from "./scheduler/hermes-job-runs.js";
import { HermesSkillsBridge } from "./scheduler/hermes-skills-bridge.js";
import { notificationStore } from "./notifications/store.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// In dev (tsx): __dirname is src/, so web/ is a sibling. In prod (dist/): go up to root then into src/web.
const WEB_DIR = __dirname.endsWith("/src/")
  ? join(__dirname, "web")
  : join(__dirname, "..", "src", "web");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

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

const harness = makeHarness({
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
const tts = new DeepgramTtsAdapter({
  apiKey: config.DEEPGRAM_API_KEY,
  model: config.DEEPGRAM_TTS_MODEL,
});
const coordinator = new TurnCoordinator(harness, tts);
const schedulerRunner = new SchedulerRunner(coordinator);
const stt = new DeepgramSttAdapter({
  apiKey: config.DEEPGRAM_API_KEY,
  model: config.DEEPGRAM_STT_MODEL,
});

// Build the monitor source up-front so routes that need the Hermes jobs bridge
// can mount against it.
let hermesJobsBridge: HermesJobsBridge | null = null;
let hermesSkillsBridge: HermesSkillsBridge | null = null;
let monitorSource: MonitorSource;
if (config.HARNESS_PROVIDER === "hermes") {
  hermesJobsBridge = new HermesJobsBridge({
    baseURL: config.HERMES_BASE_URL,
    apiKey: config.HERMES_API_KEY,
    onJobFired: async (job, prevLastRunAt) => {
      // Detect transitions on every poll. When last_run_at advances, fetch the
      // latest output file, summarize, and emit a notification. The user's
      // mobile banner will pick it up via the existing notifications subscription.
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
            metadata: {
              jobId: job.id,
              prevLastRunAt,
              source: "hermes-poll",
            },
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

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    harness: config.HARNESS_PROVIDER,
    capabilities: getCapabilities(config.HARNESS_PROVIDER),
    providers: listProviders(),
    realtime: "websocket",
    tts: tts.constructor.name,
    stt: stt.constructor.name,
    hermes:
      config.HARNESS_PROVIDER === "hermes"
        ? { baseURL: config.HERMES_BASE_URL, sessionId: config.HERMES_SESSION_ID }
        : undefined,
  }),
);

app.get("/debug/harness", async (c) => {
  const prompt = c.req.query("prompt") ?? "Reply with exactly one short line.";
  const events: unknown[] = [];
  for await (const event of harness.runTurn({ prompt })) {
    events.push(event);
  }
  return c.json({ provider: config.HARNESS_PROVIDER, events });
});

app.get("/debug/hermes", async (c) => {
  if (config.HARNESS_PROVIDER !== "hermes") {
    return c.json({ enabled: false, reason: "HARNESS_PROVIDER is not 'hermes'" });
  }
  try {
    const res = await fetch(`${config.HERMES_BASE_URL.replace(/\/$/, "")}/health`, {
      headers: { Authorization: `Bearer ${config.HERMES_API_KEY}` },
    });
    return c.json({
      enabled: true,
      reachable: res.ok,
      status: res.status,
      baseURL: config.HERMES_BASE_URL,
      sessionId: config.HERMES_SESSION_ID,
    });
  } catch (err) {
    return c.json({
      enabled: true,
      reachable: false,
      error: err instanceof Error ? err.message : "unknown",
      baseURL: config.HERMES_BASE_URL,
    });
  }
});

app.get("/debug/tts", async (c) => {
  const text = c.req.query("text") ?? "Hello from Overwatch.";
  async function* textChunks() {
    yield text;
  }

  const events: Array<Record<string, unknown>> = [];
  for await (const event of tts.synthesize({ textChunks: textChunks() })) {
    events.push(
      event.type === "audio_chunk"
        ? {
            type: event.type,
            mimeType: event.mimeType,
            bytes: event.data.byteLength,
          }
        : event,
    );
  }
  return c.json({ events });
});

app.post("/debug/stt", async (c) => {
  const arrayBuffer = await c.req.arrayBuffer();
  const transcript = await stt.transcribe({
    audio: new Uint8Array(arrayBuffer),
    mimeType: c.req.header("content-type") ?? "audio/webm",
    language: c.req.query("language") ?? "en",
  });
  return c.json(transcript);
});

app.post("/api/v1/stt", createSttHandler({ stt }));

// Monitor REST shim — proxies to /api/jobs in Hermes mode, scheduler.ts in local mode
app.route(
  "/api/v1/monitors",
  createMonitorsRouter({
    harnessProvider: config.HARNESS_PROVIDER,
    hermesBaseURL: config.HERMES_BASE_URL,
    hermesApiKey: config.HERMES_API_KEY,
    hermesJobsBridge,
  }),
);

// Hermes webhook receiver — push delivery from Hermes jobs to Overwatch notifications
app.route("/api/v1/hermes/webhook", createHermesWebhookRouter());

// Tmux orchestration — exposed for local clients that need HTTP access.
app.route(
  "/api/v1/tmux",
  createTmuxRouter({
    authToken: process.env.OVERWATCH_API_TOKEN || undefined,
  }),
);

// Static file serving for the web frontend
app.get("/*", async (c) => {
  let filePath = c.req.path === "/" ? "/index.html" : c.req.path;
  const fullPath = join(WEB_DIR, filePath);

  // Prevent directory traversal
  if (!fullPath.startsWith(WEB_DIR)) {
    return c.text("Forbidden", 403);
  }

  try {
    const content = await readFile(fullPath);
    const ext = extname(fullPath);
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    return new Response(content, {
      headers: { "Content-Type": mime },
    });
  } catch {
    return c.text("Not found", 404);
  }
});

console.log(`[overwatch] starting on http://localhost:${config.PORT}`);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[overwatch] listening on http://localhost:${info.port}`);
});
attachRealtimeServer(server, coordinator, {
  harnessProvider: config.HARNESS_PROVIDER,
  monitorSource,
  skillsBridge: hermesSkillsBridge ?? undefined,
});

if (config.HARNESS_PROVIDER === "hermes") {
  hermesJobsBridge?.start();
  hermesSkillsBridge?.start();
  console.log(
    "[hermes] mode active — local scheduler-runner disabled (cron lives in Hermes /api/jobs)",
  );
} else {
  schedulerRunner.start();
}

/**
 * /api/v1/hermes/webhook — receives push deliveries from Hermes jobs.
 *
 * In Hermes, a job's `deliver` field can be set to `"webhook"` with a URL.
 * Hermes POSTs results to that URL when the job fires. We accept those
 * payloads here and synthesize Notifications so the mobile app gets push
 * notifications without waiting for a poll cycle.
 *
 * The setup CLI offers to flip jobs to webhook delivery (or set the default).
 * Polling remains the floor — if the webhook never fires, the bridge still
 * picks up `last_run_at` transitions on its 5s tick.
 */

import { Hono } from "hono";
import { notificationStore } from "../notifications/store.js";
import { summarizeOutput } from "./hermes-job-runs.js";

export interface HermesWebhookOptions {
  /** Optional shared secret in `Authorization: Bearer ...` header */
  sharedSecret?: string;
}

interface HermesWebhookPayload {
  job_id?: string;
  name?: string;
  status?: "ok" | "error" | string;
  output?: string;
  error?: string;
  last_run_at?: string;
  // Hermes may also send other shapes — accept extra keys.
  [key: string]: unknown;
}

export function createHermesWebhookRouter(opts: HermesWebhookOptions = {}): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    if (opts.sharedSecret) {
      const auth = c.req.header("authorization") ?? "";
      if (auth !== `Bearer ${opts.sharedSecret}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }

    let payload: HermesWebhookPayload;
    try {
      payload = (await c.req.json()) as HermesWebhookPayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const jobId = String(payload.job_id ?? "unknown");
    const name = String(payload.name ?? `Hermes job ${jobId}`);
    const status = payload.status ?? "ok";
    const output =
      typeof payload.output === "string" ? payload.output : "";
    const errMsg = typeof payload.error === "string" ? payload.error : null;

    if (status === "error" || errMsg) {
      notificationStore.create({
        kind: "scheduled_task_error",
        title: `${name} failed`,
        body: errMsg ?? "Job failed",
        speakableText: `${name} failed. ${errMsg ?? ""}`.trim(),
        source: { type: "scheduler", id: jobId },
        metadata: { jobId, source: "hermes-webhook" },
      });
    } else {
      const summary = output ? summarizeOutput(output) : `${name} completed.`;
      notificationStore.create({
        kind: "scheduled_task_result",
        title: `${name} completed`,
        body: summary,
        speakableText: summary,
        source: { type: "scheduler", id: jobId },
        metadata: { jobId, source: "hermes-webhook" },
      });
    }

    return c.json({ ok: true });
  });

  return app;
}

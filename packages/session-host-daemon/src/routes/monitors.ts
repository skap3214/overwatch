/**
 * /api/v1/monitors/* — REST shim for managing monitors.
 *
 * In Hermes mode, proxies to /api/jobs on the local Hermes gateway.
 * In local mode, proxies to the local scheduler.ts CRUD functions.
 *
 * Mobile app calls /api/v1/monitors/* regardless of mode.
 */

import { Hono } from "hono";
import {
  createScheduledTask,
  deleteScheduledTask,
  loadScheduledTasks,
  type ScheduledTask,
} from "../extensions/scheduler.js";
import {
  listJobRuns,
  readJobRunOutput,
  summarizeOutput,
} from "../scheduler/hermes-job-runs.js";
import type { HermesJobsBridge } from "../scheduler/hermes-jobs-bridge.js";

export interface MonitorsRouteOptions {
  harnessProvider: string;
  hermesBaseURL: string;
  hermesApiKey: string;
  hermesJobsBridge: HermesJobsBridge | null;
}

function hermesHeaders(opts: MonitorsRouteOptions, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${opts.hermesApiKey}`,
    ...extra,
  };
}

function hermesURL(opts: MonitorsRouteOptions, suffix: string): string {
  return `${opts.hermesBaseURL.replace(/\/$/, "")}${suffix}`;
}

export function createMonitorsRouter(opts: MonitorsRouteOptions): Hono {
  const app = new Hono();
  const isHermes = opts.harnessProvider === "hermes";

  // GET /api/v1/monitors — list (returns same shape as monitor.snapshot)
  app.get("/", async (c) => {
    if (isHermes && opts.hermesJobsBridge) {
      return c.json({ monitors: opts.hermesJobsBridge.list() });
    }
    const tasks = loadScheduledTasks();
    return c.json({ monitors: tasks });
  });

  // POST /api/v1/monitors — create
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (isHermes) {
      const res = await fetch(hermesURL(opts, "/api/jobs"), {
        method: "POST",
        headers: hermesHeaders(opts, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text || res.statusText };
      }
      if (opts.hermesJobsBridge && res.ok) {
        await opts.hermesJobsBridge.refresh();
      }
      return c.json(parsed as Record<string, unknown>, res.status as any);
    }
    // Local: translate to scheduler.createScheduledTask
    const params = body as {
      name?: string;
      schedule?: string;
      prompt?: string;
      description?: string;
      recurring?: boolean;
    };
    if (!params.prompt) return c.json({ error: "prompt is required" }, 400);
    const interval = params.schedule;
    try {
      const { task } = createScheduledTask({
        prompt: params.prompt,
        interval,
        recurring: params.recurring ?? !!interval,
        description: params.description ?? params.name,
      });
      return c.json({ job: task }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "create failed" }, 400);
    }
  });

  // GET /api/v1/monitors/:id
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (isHermes) {
      const res = await fetch(hermesURL(opts, `/api/jobs/${encodeURIComponent(id)}`), {
        headers: hermesHeaders(opts),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text || res.statusText };
      }
      return c.json(parsed as Record<string, unknown>, res.status as any);
    }
    const tasks = loadScheduledTasks();
    const task = tasks.find((t: ScheduledTask) => t.id === id);
    if (!task) return c.json({ error: "Not found" }, 404);
    return c.json({ job: task });
  });

  // PATCH /api/v1/monitors/:id
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    if (isHermes) {
      const res = await fetch(hermesURL(opts, `/api/jobs/${encodeURIComponent(id)}`), {
        method: "PATCH",
        headers: hermesHeaders(opts, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text || res.statusText };
      }
      if (opts.hermesJobsBridge && res.ok) await opts.hermesJobsBridge.refresh();
      return c.json(parsed as Record<string, unknown>, res.status as any);
    }
    return c.json({ error: "Patch not supported in local mode" }, 501);
  });

  // DELETE /api/v1/monitors/:id
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (isHermes) {
      const res = await fetch(hermesURL(opts, `/api/jobs/${encodeURIComponent(id)}`), {
        method: "DELETE",
        headers: hermesHeaders(opts),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { ok: true };
      }
      if (opts.hermesJobsBridge && res.ok) await opts.hermesJobsBridge.refresh();
      return c.json(parsed as Record<string, unknown>, res.status as any);
    }
    const removed = deleteScheduledTask(id);
    if (!removed) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  // POST /api/v1/monitors/:id/(pause|resume|run)
  for (const action of ["pause", "resume", "run"] as const) {
    app.post(`/:id/${action}`, async (c) => {
      const id = c.req.param("id");
      if (!isHermes) {
        return c.json({ error: `${action} not supported in local mode` }, 501);
      }
      const res = await fetch(
        hermesURL(opts, `/api/jobs/${encodeURIComponent(id)}/${action}`),
        {
          method: "POST",
          headers: hermesHeaders(opts),
        },
      );
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text || res.statusText };
      }
      if (opts.hermesJobsBridge && res.ok) await opts.hermesJobsBridge.refresh();
      return c.json(parsed as Record<string, unknown>, res.status as any);
    });
  }

  // GET /api/v1/monitors/:id/runs — list run history (Hermes mode only)
  app.get("/:id/runs", async (c) => {
    const id = c.req.param("id");
    if (!isHermes) {
      return c.json({ runs: [], note: "Run history is only available in Hermes mode" });
    }
    const runs = await listJobRuns(id);
    return c.json({ runs });
  });

  // GET /api/v1/monitors/:id/runs/:runId — read a single run output
  app.get("/:id/runs/:runId", async (c) => {
    const id = c.req.param("id");
    const runId = c.req.param("runId");
    if (!isHermes) return c.json({ error: "Hermes mode only" }, 501);
    const content = await readJobRunOutput(id, runId);
    if (content === null) return c.json({ error: "Not found" }, 404);
    return c.json({
      runId,
      jobId: id,
      content,
      summary: summarizeOutput(content),
    });
  });

  return app;
}

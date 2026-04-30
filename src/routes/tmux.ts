/**
 * /api/v1/tmux/* — HTTP routes for clients that need to drive
 * Overwatch-managed tmux sessions.
 *
 * Loopback-only by default (the backend binds 127.0.0.1). If a token is set,
 * Bearer auth is enforced. There is intentionally no allowlist of session
 * names yet — Overwatch tracks session creation in its own state, but this
 * route group exposes raw tmux for now. See open question #1 in the plan.
 */

import { Hono } from "hono";
import {
  listPanes,
  listSessions,
  readPane,
  sendKeys,
  newSession,
  killPane,
  killSession,
} from "../tmux/cli.js";

export interface TmuxRoutesOptions {
  /** Optional bearer token to require on every request. */
  authToken?: string;
}

export function createTmuxRouter(opts: TmuxRoutesOptions = {}): Hono {
  const app = new Hono();

  if (opts.authToken) {
    app.use("*", async (c, next) => {
      const auth = c.req.header("authorization") ?? "";
      if (auth !== `Bearer ${opts.authToken}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
      await next();
    });
  }

  // GET /api/v1/tmux/sessions
  app.get("/sessions", async (c) => {
    try {
      const sessions = await listSessions();
      return c.json({ sessions });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 500);
    }
  });

  // POST /api/v1/tmux/sessions  { name, command? }
  app.post("/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { name?: string; command?: string };
    if (!body.name) return c.json({ error: "name is required" }, 400);
    try {
      const session = await newSession(body.name, body.command);
      return c.json({ session }, 201);
    } catch (err) {
      return c.json({ error: errMsg(err) }, 500);
    }
  });

  // DELETE /api/v1/tmux/sessions/:name
  app.delete("/sessions/:name", async (c) => {
    try {
      await killSession(c.req.param("name"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 500);
    }
  });

  // GET /api/v1/tmux/sessions/:name/panes
  app.get("/sessions/:name/panes", async (c) => {
    try {
      const panes = await listPanes(c.req.param("name"));
      return c.json({ panes });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 500);
    }
  });

  // GET /api/v1/tmux/sessions/:name/panes/:pane/read?lines=200
  app.get("/sessions/:name/panes/:pane/read", async (c) => {
    const target = `${c.req.param("name")}.${c.req.param("pane")}`;
    const lines = parseInt(c.req.query("lines") ?? "200", 10);
    try {
      const content = await readPane(target, lines);
      return c.json({ content });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 500);
    }
  });

  // POST /api/v1/tmux/sessions/:name/panes/:pane/keys  { keys, literal?, submit? }
  app.post("/sessions/:name/panes/:pane/keys", async (c) => {
    const target = `${c.req.param("name")}.${c.req.param("pane")}`;
    const body = (await c.req.json().catch(() => ({}))) as {
      keys?: string;
      literal?: boolean;
      submit?: boolean;
    };
    if (typeof body.keys !== "string" || !body.keys.length) {
      return c.json({ error: "keys is required" }, 400);
    }
    try {
      await sendKeys({
        target,
        keys: body.keys,
        literal: !!body.literal,
        submit: !!body.submit,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 500);
    }
  });

  // DELETE /api/v1/tmux/sessions/:name/panes/:pane
  app.delete("/sessions/:name/panes/:pane", async (c) => {
    const target = `${c.req.param("name")}.${c.req.param("pane")}`;
    try {
      await killPane(target);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 500);
    }
  });

  // POST /api/v1/tmux/send-keys  { session, pane?, keys, literal?, submit? }
  // Convenience endpoint for clients that know the session and pane separately.
  app.post("/send-keys", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      session?: string;
      pane?: string;
      keys?: string;
      literal?: boolean;
      submit?: boolean;
    };
    if (!body.session) return c.json({ error: "session is required" }, 400);
    if (typeof body.keys !== "string" || !body.keys.length) {
      return c.json({ error: "keys is required" }, 400);
    }
    const target = body.pane ? `${body.session}.${body.pane}` : body.session;
    try {
      await sendKeys({
        target,
        keys: body.keys,
        literal: !!body.literal,
        submit: !!body.submit,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMsg(err) }, 500);
    }
  });

  return app;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const stderr = (err as { stderr?: string }).stderr;
    return stderr ? stderr.trim() : err.message;
  }
  return String(err);
}

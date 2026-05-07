/**
 * /api/v1/tmux/* — HTTP routes for clients that need to drive
 * Overwatch-managed tmux sessions.
 *
 * Auth model:
 *   - Loopback (127.0.0.1) bind: the only client is local. We still require
 *     Bearer auth if `authToken` is set, but a missing token is tolerated
 *     because the kernel-level loopback restriction already keeps remote
 *     attackers out.
 *   - Non-loopback bind (0.0.0.0 / LAN): a Bearer token is mandatory.
 *     Mutating routes refuse without it. The daemon's index.ts also logs
 *     a startup warning in this configuration.
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
  /** Bearer token required on every request when bindHost is non-loopback. */
  authToken?: string;
  /** Bind hostname configured on the daemon. Drives the auth-required policy. */
  bindHost?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function createTmuxRouter(opts: TmuxRoutesOptions = {}): Hono {
  const app = new Hono();
  const isLoopback = LOOPBACK_HOSTS.has(opts.bindHost ?? "127.0.0.1");

  app.use("*", async (c, next) => {
    if (opts.authToken) {
      const auth = c.req.header("authorization") ?? "";
      if (auth !== `Bearer ${opts.authToken}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
    } else if (!isLoopback) {
      // Non-loopback bind without a token = unauthenticated remote access
      // to a tmux + key-injection surface. Refuse outright.
      return c.json(
        {
          error:
            "/api/v1/tmux is not loopback-bound and OVERWATCH_API_TOKEN is unset; refusing to serve",
        },
        503,
      );
    }
    await next();
  });

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

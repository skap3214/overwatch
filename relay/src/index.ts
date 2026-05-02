/**
 * Cloudflare Worker entry point for the Overwatch relay.
 *
 * Roles after the voice/harness-bridge overhaul:
 *
 * - Session minting (phone → Pipecat Cloud): the relay holds the Pipecat Cloud
 *   public key (PIPECAT_PUBLIC_KEY) and mints Daily room tokens on demand.
 *   The phone never sees the public key.
 *
 * - User channel routing (orchestrator ↔ Mac daemon): a per-user durable
 *   object owns two WebSocket roles (host=daemon, orchestrator=Pipecat Cloud
 *   bot) and routes JSON envelopes between them.
 *
 * Routes:
 *   GET  /api/health                              → health check
 *   POST /api/sessions/start                      → mint Pipecat Cloud session
 *   GET  /api/users/:userId/info                  → channel state
 *   GET  /api/users/:userId/ws/host               → daemon WebSocket upgrade
 *   GET  /api/users/:userId/ws/orchestrator       → orchestrator WS upgrade
 *
 * The legacy Room-based phone↔daemon pairing (audio bridge over the relay)
 * is gone — phones connect WebRTC directly to Pipecat Cloud, daemons reach
 * the orchestrator through the user channel.
 */

export { UserChannel } from "./user-channel.js";

interface Env {
  USER_CHANNEL: DurableObjectNamespace;
  /** Pipecat Cloud public key (pk_...). Use `wrangler secret put PIPECAT_PUBLIC_KEY`. */
  PIPECAT_PUBLIC_KEY?: string;
  /** Default agent name in our Pipecat Cloud org. */
  PIPECAT_AGENT_NAME?: string;
  /** Pipecat Cloud API base. */
  PIPECAT_API_BASE?: string;
}

function getUserChannelStub(env: Env, userId: string) {
  const id = env.USER_CHANNEL.idFromName(userId);
  return env.USER_CHANNEL.get(id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (path === "/api/health") {
      return Response.json(
        {
          ok: true,
          service: "overwatch-relay",
          features: {
            session_minting: Boolean(env.PIPECAT_PUBLIC_KEY),
            user_channel: true,
          },
        },
        { headers: corsHeaders },
      );
    }

    // Session minting — phone hits this to get a Daily room URL + token for
    // its WebRTC connection to Pipecat Cloud.
    if (path === "/api/sessions/start" && request.method === "POST") {
      if (!env.PIPECAT_PUBLIC_KEY) {
        return Response.json(
          { error: "PIPECAT_PUBLIC_KEY not configured on relay" },
          { status: 503, headers: corsHeaders },
        );
      }

      let body: {
        user_id?: string;
        pairing_token?: string;
        session_token?: string;
      };
      try {
        body = (await request.json()) as {
          user_id?: string;
          pairing_token?: string;
          session_token?: string;
        };
      } catch {
        return Response.json(
          { error: "invalid JSON body" },
          { status: 400, headers: corsHeaders },
        );
      }

      if (!body.user_id || !body.pairing_token || !body.session_token) {
        return Response.json(
          {
            error: "user_id, pairing_token, and session_token required",
          },
          { status: 400, headers: corsHeaders },
        );
      }

      const apiBase = env.PIPECAT_API_BASE ?? "https://api.pipecat.daily.co/v1";
      const agentName = env.PIPECAT_AGENT_NAME ?? "overwatch-orchestrator";

      try {
        const pccRes = await fetch(`${apiBase}/public/${agentName}/start`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.PIPECAT_PUBLIC_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            createDailyRoom: true,
            // Pipecat Cloud forwards body data to the bot's runner_args.body.
            // Bot uses pairing_token to authenticate its WS to the relay's
            // user-channel, and session_token (HMAC of session_id|expires_at,
            // signed by the phone with the shared pairing_token) on every
            // outbound harness_command envelope so the daemon's TokenValidator
            // can verify it.
            body: {
              user_id: body.user_id,
              pairing_token: body.pairing_token,
              session_token: body.session_token,
            },
          }),
        });

        if (!pccRes.ok) {
          const detail = await pccRes.text().catch(() => "");
          return Response.json(
            {
              error: `Pipecat Cloud session start failed: ${pccRes.status}`,
              detail,
            },
            { status: 502, headers: corsHeaders },
          );
        }

        const data = (await pccRes.json()) as {
          dailyRoom?: string;
          dailyToken?: string;
          [k: string]: unknown;
        };
        return Response.json(
          {
            daily_room_url: data.dailyRoom,
            daily_token: data.dailyToken,
          },
          { headers: corsHeaders },
        );
      } catch (err) {
        return Response.json(
          {
            error: "Pipecat Cloud session start failed",
            detail: err instanceof Error ? err.message : String(err),
          },
          { status: 502, headers: corsHeaders },
        );
      }
    }

    // User channel: /api/users/:userId/(info|ws/host|ws/orchestrator)
    const userMatch = path.match(/^\/api\/users\/([^/]+)\/(.+)$/);
    if (userMatch) {
      const userId = decodeURIComponent(userMatch[1]);
      const subPath = userMatch[2];
      const stub = getUserChannelStub(env, userId);

      if (subPath === "info") {
        const infoRes = await stub.fetch(new Request("https://internal/info"));
        const info = (await infoRes.json()) as Record<string, unknown>;
        return Response.json({ user_id: userId, ...info }, { headers: corsHeaders });
      }

      if (subPath === "ws/host" || subPath === "ws/orchestrator") {
        const doUrl = new URL(request.url);
        return stub.fetch(new Request(doUrl.toString(), request));
      }
    }

    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders },
    );
  },
};

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
 * Security note: the long-term `pairing_token` (the QR-pair secret shared
 * between phone, daemon, and the relay's UserChannel DO) is NEVER forwarded
 * to Pipecat Cloud. Instead the relay verifies the phone-derived
 * `session_token` itself, then mints a short-lived `orchestrator_token`
 * scoped to this user + session and passes only that to PCC. The orchestrator
 * uses it to authenticate its `ws/orchestrator` upgrade. If a PCC pod
 * leaks env/runner-args, only the orchestrator_token is exposed; the
 * pairing secret stays in the trust circle of phone↔relay↔daemon.
 *
 * Routes:
 *   GET  /api/health                              → health check
 *   POST /api/sessions/start                      → mint Pipecat Cloud session
 *   GET  /api/users/:userId/info                  → channel state
 *   GET  /api/users/:userId/ws/host               → daemon WebSocket upgrade
 *   GET  /api/users/:userId/ws/orchestrator       → orchestrator WS upgrade
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

/**
 * Verify that `sessionToken` was signed by `pairingToken` and hasn't expired.
 * Format: `{session_id}|{expires_at}|{hex_hmac}` — same as the daemon's TS
 * TokenValidator + the orchestrator's Python TokenValidator.
 */
async function verifySessionToken(
  pairingToken: string,
  sessionToken: string,
): Promise<{ session_id: string; expires_at: number } | null> {
  const parts = sessionToken.split("|");
  if (parts.length !== 3) return null;
  const [session_id, expiresStr, sig] = parts;
  const expires_at = Number.parseInt(expiresStr, 10);
  if (!Number.isFinite(expires_at)) return null;
  if (expires_at < Math.floor(Date.now() / 1000)) return null;

  const expected = await hmacSha256Hex(pairingToken, `${session_id}|${expires_at}`);
  if (!timingSafeStringEqual(sig, expected)) return null;
  return { session_id, expires_at };
}

/**
 * Mint a short-lived orchestrator-WS auth token. Format mirrors `session_token`
 * so the DO's verification code is symmetrical: `{user_id}|{expires_at}|{sig}`
 * where sig = HMAC(pairing_token, "orch:{user_id}|{expires_at}"). The DO
 * already holds the pairing_token (seeded by the daemon's first ws/host
 * connect), so it can recompute the HMAC without ever seeing pairing_token
 * traverse PCC.
 */
async function mintOrchestratorToken(
  pairingToken: string,
  userId: string,
  ttlSeconds: number = 60 * 60,
): Promise<string> {
  const expires_at = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmacSha256Hex(pairingToken, `orch:${userId}|${expires_at}`);
  return `${userId}|${expires_at}|${sig}`;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeTTSProvider(value: string | undefined): "cartesia" | "xai" | undefined | null {
  if (value === undefined || value === "") return undefined;
  if (value === "cartesia" || value === "xai") return value;
  return null;
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
        tts_provider?: string;
      };
      try {
        body = (await request.json()) as {
          user_id?: string;
          pairing_token?: string;
          session_token?: string;
          tts_provider?: string;
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

      const ttsProvider = normalizeTTSProvider(body.tts_provider);
      if (ttsProvider === null) {
        return Response.json(
          { error: "tts_provider must be cartesia or xai" },
          { status: 400, headers: corsHeaders },
        );
      }

      // Verify session_token at the relay so a tampered or expired token
      // never reaches Pipecat Cloud.
      const claims = await verifySessionToken(body.pairing_token, body.session_token);
      if (!claims) {
        return Response.json(
          { error: "invalid or expired session_token" },
          { status: 401, headers: corsHeaders },
        );
      }

      // Seed the user-channel DO with the pairing_token so it can verify
      // the orchestrator_token we're about to mint when the bot opens its
      // ws/orchestrator. Idempotent — the DO ignores re-seeds for the same
      // value and rejects mismatches.
      const stub = getUserChannelStub(env, body.user_id);
      const seedRes = await stub.fetch(
        new Request("https://internal/seed", {
          method: "POST",
          body: JSON.stringify({ pairing_token: body.pairing_token }),
        }),
      );
      if (!seedRes.ok) {
        return Response.json(
          { error: "user channel auth seed failed" },
          { status: 500, headers: corsHeaders },
        );
      }

      const orchestratorToken = await mintOrchestratorToken(
        body.pairing_token,
        body.user_id,
      );

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
            // PCC forwards body to the bot's runner_args.body.
            // - user_id: which user this session belongs to
            // - session_token: stamped on every harness_command envelope so
            //                  the daemon's TokenValidator verifies it
            // - orchestrator_token: short-lived auth for the bot's
            //                       ws/orchestrator upgrade to the relay
            // pairing_token is INTENTIONALLY NOT sent here — it stays on
            // phone↔relay↔daemon only.
            body: {
              user_id: body.user_id,
              session_token: body.session_token,
              orchestrator_token: orchestratorToken,
              ...(ttsProvider ? { tts_provider: ttsProvider } : {}),
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
        // Pass user_id through the URL so the DO can verify the
        // orchestrator_token's HMAC (which is keyed on user_id + expires_at).
        doUrl.searchParams.set("__user_id", userId);
        return stub.fetch(new Request(doUrl.toString(), request));
      }
    }

    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders },
    );
  },
};

/**
 * Cloudflare Worker entry point for the Overwatch relay.
 *
 * Roles after the voice/harness-bridge overhaul:
 *
 * - QR pairing (phone ↔ Mac): existing 2-peer room model, host = Mac, client = phone.
 *   Carries pair-time signaling only. After the WebRTC peer with Pipecat Cloud is
 *   established, the phone disconnects.
 *
 * - Session minting (phone → Pipecat Cloud): the relay holds the Pipecat Cloud
 *   public key (PIPECAT_PUBLIC_KEY) and mints Daily room tokens on demand.
 *   The phone never sees the public key.
 *
 * - Harness command/event bridge (orchestrator ↔ Mac daemon): the cloud orchestrator
 *   joins a per-user room and forwards encrypted JSON envelopes to the Mac. The
 *   Mac daemon emits HarnessEvents back through the same channel.
 *
 * Routes:
 *   GET  /api/health                       → health check
 *   POST /api/room/create                  → create a new room (existing)
 *   GET  /api/room/:code/join              → room info (existing)
 *   GET  /api/room/:code/ws/host           → host WebSocket (existing)
 *   GET  /api/room/:code/ws/client         → client WebSocket (existing)
 *   POST /api/sessions/start               → NEW: mint Pipecat Cloud session for the phone
 *
 * NOTE: audio no longer flows through the relay. The legacy `voice.audio` envelope
 * and the inbound STT path are deleted (handled by the cloud orchestrator).
 */

export { Room } from "./room.js";

interface Env {
  ROOM: DurableObjectNamespace;
  /** Pipecat Cloud public key (pk_...). Use `wrangler secret put PIPECAT_PUBLIC_KEY`. */
  PIPECAT_PUBLIC_KEY?: string;
  /** Default agent name in our Pipecat Cloud org. */
  PIPECAT_AGENT_NAME?: string;
  /** Pipecat Cloud API base. */
  PIPECAT_API_BASE?: string;
}

function generateRoomCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "0123456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  code += "-";
  for (let i = 0; i < 4; i++) {
    code += digits[Math.floor(Math.random() * digits.length)];
  }
  return code;
}

function getRoomStub(env: Env, roomCode: string) {
  const id = env.ROOM.idFromName(roomCode);
  return { stub: env.ROOM.get(id), roomId: id.toString() };
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
          },
        },
        { headers: corsHeaders }
      );
    }

    // Session minting — phone hits this to get a Daily room URL + token for
    // its WebRTC connection to Pipecat Cloud. The pk_... key never leaves the
    // relay; the phone only ever sees the room url + room token.
    if (path === "/api/sessions/start" && request.method === "POST") {
      if (!env.PIPECAT_PUBLIC_KEY) {
        return Response.json(
          { error: "PIPECAT_PUBLIC_KEY not configured on relay" },
          { status: 503, headers: corsHeaders }
        );
      }

      let body: { user_id?: string; pairing_token?: string };
      try {
        body = (await request.json()) as { user_id?: string; pairing_token?: string };
      } catch {
        return Response.json(
          { error: "invalid JSON body" },
          { status: 400, headers: corsHeaders }
        );
      }

      if (!body.user_id || !body.pairing_token) {
        return Response.json(
          { error: "user_id and pairing_token required" },
          { status: 400, headers: corsHeaders }
        );
      }

      const apiBase = env.PIPECAT_API_BASE ?? "https://api.pipecat.daily.co/v1";
      const agentName = env.PIPECAT_AGENT_NAME ?? "overwatch-orchestrator";

      try {
        const pccRes = await fetch(`${apiBase}/agents/${agentName}/start`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.PIPECAT_PUBLIC_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            createDailyRoom: true,
            // Pipecat Cloud forwards body data to the bot for per-session config.
            body: { user_id: body.user_id, pairing_token: body.pairing_token },
          }),
        });

        if (!pccRes.ok) {
          const detail = await pccRes.text().catch(() => "");
          return Response.json(
            {
              error: `Pipecat Cloud session start failed: ${pccRes.status}`,
              detail,
            },
            { status: 502, headers: corsHeaders }
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
          { headers: corsHeaders }
        );
      } catch (err) {
        return Response.json(
          {
            error: "Pipecat Cloud session start failed",
            detail: err instanceof Error ? err.message : String(err),
          },
          { status: 502, headers: corsHeaders }
        );
      }
    }

    // Create a new room — generates code, returns room + roomId
    if (path === "/api/room/create" && request.method === "POST") {
      const roomCode = generateRoomCode();
      const { roomId } = getRoomStub(env, roomCode);
      return Response.json(
        { room: roomCode, roomId },
        { headers: corsHeaders }
      );
    }

    // Room routes: /api/room/:code/...
    const roomMatch = path.match(/^\/api\/room\/([A-Z0-9-]+)\/(.*)/);
    if (!roomMatch) {
      return Response.json(
        { error: "Not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const roomCode = roomMatch[1];
    const subPath = roomMatch[2];
    const { stub, roomId } = getRoomStub(env, roomCode);

    // Join info: /api/room/:code/join — returns roomId + hostPublicKey for manual entry
    if (subPath === "join") {
      const infoRes = await stub.fetch(new Request("https://internal/join"));
      const info = (await infoRes.json()) as { hostPublicKey?: string; peers: number };
      return Response.json(
        { room: roomCode, roomId, ...info },
        { headers: corsHeaders }
      );
    }

    // WebSocket: /api/room/:code/ws/(host|client)
    const wsMatch = subPath.match(/^ws\/(host|client)$/);
    if (wsMatch) {
      // Pass roomId and any query params through to the DO
      const doUrl = new URL(request.url);
      doUrl.searchParams.set("roomId", roomId);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders }
    );
  },
};

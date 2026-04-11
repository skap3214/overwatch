/**
 * Cloudflare Worker entry point for the Overwatch relay.
 *
 * Routes:
 *   GET  /api/health                    → health check
 *   POST /api/room/create               → create a new room
 *   GET  /api/room/:code/join           → get room info for manual code entry
 *   GET  /api/room/:code/ws/host        → WebSocket upgrade (host side)
 *   GET  /api/room/:code/ws/client      → WebSocket upgrade (client side)
 */

export { Room } from "./room.js";

interface Env {
  ROOM: DurableObjectNamespace;
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
        { ok: true, service: "overwatch-relay" },
        { headers: corsHeaders }
      );
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

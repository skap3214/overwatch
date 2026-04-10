/**
 * Cloudflare Worker entry point for the Overwatch relay.
 *
 * Routes:
 *   GET  /api/health                    → health check
 *   POST /api/room/create               → create a new room, returns { room }
 *   GET  /api/room/:code/ws/host        → WebSocket upgrade (host side)
 *   GET  /api/room/:code/ws/client      → WebSocket upgrade (client side)
 *   GET  /api/room/:code/info           → room status (peer count)
 */

export { Room } from "./room.js";

interface Env {
  ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (path === "/api/health") {
      return Response.json(
        { ok: true, service: "overwatch-relay" },
        { headers: corsHeaders }
      );
    }

    // Create a new room
    if (path === "/api/room/create" && request.method === "POST") {
      // Use a random ID for the Durable Object
      const id = env.ROOM.newUniqueId();
      const stub = env.ROOM.get(id);

      // Hit the DO to generate a room code
      const infoRes = await stub.fetch(
        new Request("https://internal/info")
      );
      const info = (await infoRes.json()) as { room: string };

      // Store the mapping: room code → DO ID
      // For v1, we encode the DO ID in the room code response
      // and the client passes it back when connecting
      return Response.json(
        {
          room: info.room,
          // The client will need the DO ID to connect — encode it
          roomId: id.toString(),
        },
        { headers: corsHeaders }
      );
    }

    // Room WebSocket connections: /api/room/:code/ws/(host|client)
    const wsMatch = path.match(
      /^\/api\/room\/([A-Z0-9-]+)\/ws\/(host|client)$/
    );
    if (wsMatch) {
      const roomId = url.searchParams.get("roomId");
      if (!roomId) {
        return Response.json(
          { error: "Missing roomId query parameter" },
          { status: 400, headers: corsHeaders }
        );
      }

      const id = env.ROOM.idFromString(roomId);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    // Room info: /api/room/:code/info
    const infoMatch = path.match(/^\/api\/room\/([A-Z0-9-]+)\/info$/);
    if (infoMatch) {
      const roomId = url.searchParams.get("roomId");
      if (!roomId) {
        return Response.json(
          { error: "Missing roomId query parameter" },
          { status: 400, headers: corsHeaders }
        );
      }

      const id = env.ROOM.idFromString(roomId);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders }
    );
  },
};

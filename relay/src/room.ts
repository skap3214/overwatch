/**
 * Durable Object: Room
 *
 * Holds up to 2 WebSocket connections (host + client).
 * Forwards all frames (text and binary) between them without inspection.
 * Text frames are used during key exchange. Binary frames are encrypted messages.
 */

type Role = "host" | "client";

interface ConnectedPeer {
  socket: WebSocket;
  role: Role;
}

export class Room implements DurableObject {
  private peers: ConnectedPeer[] = [];
  private roomCode: string | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Record<string, unknown>
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Generate room code on first request
    if (!this.roomCode) {
      this.roomCode = this.generateRoomCode();
    }

    if (url.pathname.endsWith("/info")) {
      return Response.json({ room: this.roomCode, peers: this.peers.length });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    // Determine role from path
    const role: Role = url.pathname.includes("/host") ? "host" : "client";

    // If the same role reconnects, replace the old connection
    const existing = this.peers.find((p) => p.role === role);
    if (existing) {
      try { existing.socket.close(1000, "replaced"); } catch {}
      this.peers = this.peers.filter((p) => p.role !== role);
    }

    const pair = new WebSocketPair();
    const [clientWs, serverWs] = pair;

    this.state.acceptWebSocket(serverWs, [role]);

    this.peers.push({ socket: serverWs, role });

    // Cancel cleanup if a peer reconnects
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    // Forward to the other peer
    const other = this.peers.find((p) => p.socket !== ws);
    if (!other) return;

    try {
      if (typeof message === "string") {
        other.socket.send(message);
      } else {
        other.socket.send(message);
      }
    } catch {
      // Other side disconnected
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    this.removePeer(ws);
    this.scheduleCleanup();
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.removePeer(ws);
    this.scheduleCleanup();
  }

  private removePeer(ws: WebSocket): void {
    this.peers = this.peers.filter((p) => p.socket !== ws);
  }

  private scheduleCleanup(): void {
    if (this.peers.length > 0) return;
    if (this.cleanupTimer) return;

    // Give 30s for reconnection before the DO gets evicted
    this.cleanupTimer = setTimeout(() => {
      // No peers left — DO will be evicted by the runtime
      this.cleanupTimer = null;
    }, 30_000);
  }

  private generateRoomCode(): string {
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O (ambiguous)
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
}

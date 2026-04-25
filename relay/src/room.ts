/**
 * Durable Object: Room
 *
 * Holds up to 2 WebSocket connections (host + client).
 * Forwards all frames (text and binary) between them without inspection.
 *
 * Control plane (plaintext text frames):
 *   ping/pong     — keepalive between each endpoint and the DO
 *   peer.disconnected — instant notification when the other side dies
 *   bridge.status — end-to-end readiness signal from host to client
 *
 * Data plane (binary frames): E2E encrypted, forwarded opaquely.
 *
 * Uses state.getWebSockets() to survive hibernation.
 */

type Role = "host" | "client";

interface ControlFrame {
  type: string;
  [key: string]: unknown;
}

function tryParseControl(message: string): ControlFrame | null {
  try {
    const parsed = JSON.parse(message);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.type === "string") {
      return parsed as ControlFrame;
    }
  } catch {}
  return null;
}

export class Room implements DurableObject {
  private alarmScheduled = false;
  private hostPublicKey: string | null = null;
  private lastBridgeStatus: string | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly _env: Record<string, unknown>
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Join info — returns host public key for manual code entry
    if (url.pathname.endsWith("/join")) {
      const allSockets = this.state.getWebSockets();
      const hostPublicKey =
        this.hostPublicKey ??
        ((await this.state.storage.get("hostPublicKey")) as string | null);
      const lastBridgeStatus =
        this.lastBridgeStatus ??
        ((await this.state.storage.get("lastBridgeStatus")) as string | null);
      return Response.json({
        peers: allSockets.length,
        hostPublicKey,
        bridgeReady: lastBridgeStatus
          ? tryParseControl(lastBridgeStatus)?.ready === true
          : false,
      });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const role: Role = url.pathname.includes("/host") ? "host" : "client";

    // Store host's public key for manual code entry
    if (role === "host") {
      const hpk = url.searchParams.get("hostPublicKey");
      if (hpk) {
        this.hostPublicKey = hpk;
        await this.state.storage.put("hostPublicKey", hpk);
      }
    }

    // Replace existing connection for this role
    const existing = this.state.getWebSockets(role);
    for (const ws of existing) {
      try { ws.close(1000, "replaced"); } catch {}
    }

    const pair = new WebSocketPair();
    const clientWs = pair[0];
    const serverWs = pair[1];

    this.state.acceptWebSocket(serverWs, [role]);

    if (role === "client") {
      const status =
        this.lastBridgeStatus ??
        ((await this.state.storage.get("lastBridgeStatus")) as string | null);
      if (status) {
        try { serverWs.send(status); } catch {}
      }
    }

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    // Binary frames: always forward opaquely (encrypted data plane)
    if (typeof message !== "string") {
      this.forwardToPeer(ws, message);
      return;
    }

    // Text frames: check for control plane messages
    const ctrl = tryParseControl(message);
    if (ctrl) {
      switch (ctrl.type) {
        case "ping":
          // Reply with pong, update heartbeat timestamp
          ws.send(JSON.stringify({ type: "pong" }));
          ws.serializeAttachment({ lastPingTs: Date.now() });
          this.ensureAlarm();
          return;

        case "pong":
          // Should not arrive here (DO sends pongs, not receives), ignore
          return;

        case "bridge.status": {
          // Cache readiness so reconnecting clients get immediate state.
          this.lastBridgeStatus = message;
          await this.state.storage.put("lastBridgeStatus", message);
          const clients = this.state.getWebSockets("client");
          for (const client of clients) {
            try { client.send(message); } catch {}
          }
          return;
        }
      }
    }

    // All other text frames (client.hello, etc): forward to peer
    this.forwardToPeer(ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    // Don't notify peer for "replaced" closes (same role reconnecting)
    if (reason === "replaced") return;

    await this.notifyPeerDisconnected(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.notifyPeerDisconnected(ws);
  }

  async alarm(): Promise<void> {
    this.alarmScheduled = false;
    const now = Date.now();
    const allSockets = this.state.getWebSockets();
    let remaining = 0;

    for (const ws of allSockets) {
      const attachment = ws.deserializeAttachment() as { lastPingTs?: number } | null;
      const lastPing = attachment?.lastPingTs ?? 0;

      if (now - lastPing > 45_000) {
        // No ping in 45s — close as dead
        try { ws.close(4000, "heartbeat_timeout"); } catch {}
      } else {
        remaining++;
      }
    }

    // Reschedule if sockets remain
    if (remaining > 0) {
      this.ensureAlarm();
    }
  }

  private forwardToPeer(sender: WebSocket, message: string | ArrayBuffer): void {
    const senderTags = this.state.getTags(sender);
    const senderRole: Role = senderTags.includes("host") ? "host" : "client";
    const otherRole: Role = senderRole === "host" ? "client" : "host";

    const others = this.state.getWebSockets(otherRole);
    for (const other of others) {
      try { other.send(message); } catch {}
    }
  }

  private async notifyPeerDisconnected(ws: WebSocket): Promise<void> {
    const tags = this.state.getTags(ws);
    const role: Role = tags.includes("host") ? "host" : "client";
    const otherRole: Role = role === "host" ? "client" : "host";

    if (role === "host") {
      this.lastBridgeStatus = JSON.stringify({ type: "bridge.status", ready: false });
      await this.state.storage.put("lastBridgeStatus", this.lastBridgeStatus);
    }

    const others = this.state.getWebSockets(otherRole);
    const notification = JSON.stringify({ type: "peer.disconnected", role });
    for (const other of others) {
      try { other.send(notification); } catch {}
    }
  }

  private ensureAlarm(): void {
    if (this.alarmScheduled) return;
    this.alarmScheduled = true;
    this.state.storage.setAlarm(Date.now() + 60_000);
  }

}

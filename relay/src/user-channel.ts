/**
 * UserChannel durable object.
 *
 * One DO per `user_id`. Holds two text-only WebSocket roles:
 *
 *   - host:         the user's Mac daemon (AdapterProtocolServer)
 *   - orchestrator: the cloud orchestrator (Pipecat Cloud session)
 *
 * Routes JSON envelopes between them. Text frames only — no binary path.
 *
 * Authentication: each side presents `?token=<pairingToken>` on the WS
 * upgrade. The DO records the first token seen and refuses any later
 * connection that doesn't match. (This is the alpha-grade trust model from
 * plan §7. Hardening = future plan.)
 *
 * Replaces the legacy Room DO from the pre-overhaul relay. Phone never
 * connects to a UserChannel — phone uses POST /api/sessions/start only.
 */

type Role = "host" | "orchestrator";

interface ControlFrame {
  type: string;
  [key: string]: unknown;
}

function tryParseControl(message: string): ControlFrame | null {
  try {
    const parsed = JSON.parse(message);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.type === "string"
    ) {
      return parsed as ControlFrame;
    }
  } catch {}
  return null;
}

export class UserChannel implements DurableObject {
  private alarmScheduled = false;
  private pairingToken: string | null = null;

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/info")) {
      const sockets = this.state.getWebSockets();
      const hostCount = this.state.getWebSockets("host").length;
      const orchestratorCount = this.state.getWebSockets("orchestrator").length;
      return Response.json({
        peers: sockets.length,
        host_connected: hostCount > 0,
        orchestrator_connected: orchestratorCount > 0,
      });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    let role: Role;
    if (url.pathname.includes("/ws/orchestrator")) {
      role = "orchestrator";
    } else if (url.pathname.includes("/ws/host")) {
      role = "host";
    } else {
      return new Response("Bad role", { status: 400 });
    }

    // Verify pairing token. First connection sets the token; subsequent
    // connections must match.
    const token = url.searchParams.get("token") ?? "";
    if (!token) {
      return new Response("Missing pairing token", { status: 401 });
    }

    const stored =
      this.pairingToken ??
      ((await this.state.storage.get("pairingToken")) as string | null);

    if (!stored) {
      // First connection — accept this token as canonical.
      this.pairingToken = token;
      await this.state.storage.put("pairingToken", token);
    } else if (stored !== token) {
      return new Response("Invalid pairing token", { status: 403 });
    } else {
      this.pairingToken = stored;
    }

    // Replace existing connection for this role.
    const existing = this.state.getWebSockets(role);
    for (const ws of existing) {
      try {
        ws.close(1000, "replaced");
      } catch {}
    }

    const pair = new WebSocketPair();
    const clientWs = pair[0];
    const serverWs = pair[1];

    this.state.acceptWebSocket(serverWs, [role]);

    // Notify the peer that this role just connected.
    const peerRole: Role = role === "host" ? "orchestrator" : "host";
    const peers = this.state.getWebSockets(peerRole);
    const ready = JSON.stringify({ type: "channel.peer_connected", role });
    for (const peer of peers) {
      try {
        peer.send(ready);
      } catch {}
    }

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // Binary frames are not part of the protocol on this channel.
    if (typeof message !== "string") {
      return;
    }

    const ctrl = tryParseControl(message);
    if (ctrl) {
      switch (ctrl.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          ws.serializeAttachment({ lastPingTs: Date.now() });
          this.ensureAlarm();
          return;
        case "pong":
          return;
      }
    }

    this.forwardToPeer(ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
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
      const attachment = ws.deserializeAttachment() as
        | { lastPingTs?: number }
        | null;
      const lastPing = attachment?.lastPingTs ?? 0;
      if (now - lastPing > 45_000) {
        try {
          ws.close(4000, "heartbeat_timeout");
        } catch {}
      } else {
        remaining++;
      }
    }
    if (remaining > 0) {
      this.ensureAlarm();
    }
  }

  private forwardToPeer(sender: WebSocket, message: string): void {
    const tags = this.state.getTags(sender);
    const senderRole: Role = tags.includes("host") ? "host" : "orchestrator";
    const peerRole: Role = senderRole === "host" ? "orchestrator" : "host";
    const peers = this.state.getWebSockets(peerRole);
    for (const peer of peers) {
      try {
        peer.send(message);
      } catch {}
    }
  }

  private async notifyPeerDisconnected(ws: WebSocket): Promise<void> {
    const tags = this.state.getTags(ws);
    const role: Role = tags.includes("host") ? "host" : "orchestrator";
    const peerRole: Role = role === "host" ? "orchestrator" : "host";
    const peers = this.state.getWebSockets(peerRole);
    const notification = JSON.stringify({
      type: "channel.peer_disconnected",
      role,
    });
    for (const peer of peers) {
      try {
        peer.send(notification);
      } catch {}
    }
  }

  private ensureAlarm(): void {
    if (this.alarmScheduled) return;
    this.alarmScheduled = true;
    this.state.storage.setAlarm(Date.now() + 60_000);
  }
}

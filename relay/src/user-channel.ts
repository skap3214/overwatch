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
 * Authentication:
 *   - ws/host: presents `?token=<pairing_token>` directly. First connection
 *     seeds the DO's `pairingToken`; subsequent connections must match.
 *     The pairing token also gets seeded by the relay's
 *     /api/sessions/start handler (POST /seed) so the orchestrator's
 *     verification doesn't depend on the daemon connecting first.
 *
 *   - ws/orchestrator: presents `?token=<orchestrator_token>` where
 *     orchestrator_token = `{user_id}|{expires_at}|HMAC(pairing_token,
 *     "orch:{user_id}|{expires_at}")`. The DO verifies the HMAC using its
 *     stored pairingToken — this lets the relay mint short-lived tokens
 *     for Pipecat Cloud bots WITHOUT ever exposing the long-term
 *     pairing_token to PCC.
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

    // POST /seed { pairing_token } — relay calls this from session-start to
    // ensure the DO has the pairing_token recorded BEFORE PCC starts the
    // orchestrator. Idempotent for the same value; conflict on mismatch.
    if (url.pathname.endsWith("/seed") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        pairing_token?: string;
      };
      if (!body.pairing_token) {
        return new Response("missing pairing_token", { status: 400 });
      }
      const stored = await this._loadPairingToken();
      if (!stored) {
        this.pairingToken = body.pairing_token;
        await this.state.storage.put("pairingToken", body.pairing_token);
      } else if (stored !== body.pairing_token) {
        return new Response("pairing token mismatch for user", { status: 409 });
      }
      return Response.json({ ok: true });
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

    const token = url.searchParams.get("token") ?? "";
    if (!token) {
      return new Response("Missing auth token", { status: 401 });
    }

    if (role === "host") {
      // ws/host accepts the long-term pairing_token directly.
      const stored = await this._loadPairingToken();
      if (!stored) {
        // First connection — accept this token as canonical.
        this.pairingToken = token;
        await this.state.storage.put("pairingToken", token);
      } else if (stored !== token) {
        return new Response("Invalid pairing token", { status: 403 });
      } else {
        this.pairingToken = stored;
      }
    } else {
      // ws/orchestrator accepts a short-lived signed orchestrator_token. The
      // DO must already have the pairing_token (seeded via POST /seed by the
      // session-start handler, or learned from a prior ws/host connection).
      const stored = await this._loadPairingToken();
      if (!stored) {
        return new Response(
          "user channel not initialized — seed pairing_token first",
          { status: 401 },
        );
      }
      const userId = url.searchParams.get("__user_id") ?? "";
      const valid = await this._verifyOrchestratorToken(stored, userId, token);
      if (!valid) {
        return new Response("Invalid or expired orchestrator_token", {
          status: 403,
        });
      }
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

  private async _loadPairingToken(): Promise<string | null> {
    if (this.pairingToken) return this.pairingToken;
    const stored = (await this.state.storage.get("pairingToken")) as
      | string
      | null;
    if (stored) this.pairingToken = stored;
    return stored;
  }

  private async _verifyOrchestratorToken(
    pairingToken: string,
    userId: string,
    token: string,
  ): Promise<boolean> {
    const parts = token.split("|");
    if (parts.length !== 3) return false;
    const [tokenUser, expiresStr, sig] = parts;
    if (tokenUser !== userId) return false;
    const expires_at = Number.parseInt(expiresStr, 10);
    if (!Number.isFinite(expires_at)) return false;
    if (expires_at < Math.floor(Date.now() / 1000)) return false;
    const expected = await hmacSha256Hex(
      pairingToken,
      `orch:${userId}|${expires_at}`,
    );
    return timingSafeStringEqual(sig, expected);
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

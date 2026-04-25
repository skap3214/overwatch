import type { WsEnvelope, ConnectionStatus } from "../types";
import {
  generateKeyPair,
  deriveSharedKey,
  encrypt,
  decryptToString,
  toBase64,
  fromBase64,
  type KeyPair,
} from "./crypto";

export type ConnectionMode = "direct" | "relay";

type EnvelopeHandler = (envelope: WsEnvelope) => void;
type StatusHandler = (status: ConnectionStatus) => void;

export interface RelayConfig {
  relayUrl: string;
  room: string;
  hostPublicKey: string; // base64
}

function toWebSocketURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) {
    return trimmed.replace(/^https:\/\//, "wss://") + "/api/v1/ws";
  }
  if (trimmed.startsWith("http://")) {
    return trimmed.replace(/^http:\/\//, "ws://") + "/api/v1/ws";
  }
  return trimmed + "/api/v1/ws";
}

function toRelayWebSocketURL(config: RelayConfig): string {
  const base = config.relayUrl.replace(/\/+$/, "");
  const wsBase = base.startsWith("https://")
    ? base.replace(/^https:\/\//, "wss://")
    : base.replace(/^http:\/\//, "ws://");
  return `${wsBase}/api/room/${config.room}/ws/client`;
}

function backoffDelay(attempt: number): number {
  return Math.min(30_000, 1000 * Math.pow(2, attempt)) + Math.random() * 500;
}

class RealtimeClient {
  private socket: WebSocket | null = null;
  private envelopeHandler: EnvelopeHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private baseURL: string | null = null;
  private currentURL: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;

  // Relay mode encryption state
  private _mode: ConnectionMode = "direct";
  private relayConfig: RelayConfig | null = null;
  private keyPair: KeyPair | null = null;
  private sharedKey: Uint8Array | null = null;

  // Heartbeat state
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private missedPongs = 0;

  // Reconnection state
  private reconnectAttempt = 0;

  // Relay readiness (only applies in relay mode)
  private peerPresent = false;
  private bridgeReady = false;

  get mode(): ConnectionMode {
    return this._mode;
  }

  setHandlers(params: {
    onEnvelope: EnvelopeHandler;
    onStatus: StatusHandler;
  }): void {
    this.envelopeHandler = params.onEnvelope;
    this.statusHandler = params.onStatus;
  }

  /** Direct mode: connect to the backend WebSocket directly */
  connect(baseURL: string): void {
    if (!baseURL) return;
    this._mode = "direct";
    this.relayConfig = null;
    this.keyPair = null;
    this.sharedKey = null;
    this.baseURL = baseURL.replace(/\/+$/, "");
    const wsURL = toWebSocketURL(baseURL);
    if (
      this.socket &&
      this.currentURL === wsURL &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.clearTimers();
    if (this.socket) this.socket.close();
    this.manuallyClosed = false;
    this.currentURL = wsURL;
    this.emitStatus("connecting");
    this.openSocket(wsURL);
  }

  /** Relay mode: connect via the relay with E2E encryption */
  connectViaRelay(config: RelayConfig, isReconnect = false): void {
    this._mode = "relay";
    this.relayConfig = config;
    this.baseURL = null;

    this.clearTimers();

    if (!isReconnect || !this.keyPair || !this.sharedKey) {
      this.keyPair = generateKeyPair();
      const hostPublicKey = fromBase64(config.hostPublicKey);
      this.sharedKey = deriveSharedKey(hostPublicKey, this.keyPair.secretKey);
    }

    // Reset readiness on new connection
    this.peerPresent = false;
    this.bridgeReady = false;

    const wsURL = toRelayWebSocketURL(config);
    if (this.socket) this.socket.close();
    this.manuallyClosed = false;
    this.currentURL = wsURL;
    this.emitStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    this.openSocket(wsURL);
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.baseURL = null;
    this.peerPresent = false;
    this.bridgeReady = false;
    this.reconnectAttempt = 0;
    this.clearTimers();
    this.clearHeartbeat();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.emitStatus("disconnected");
  }

  /** Send a typed envelope. Returns false if not ready (caller should show error). */
  send(type: string, payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.log(`[realtime] send DROPPED ${type}: socket not open`);
      return false;
    }

    // In relay mode, also check peer/bridge readiness
    if (this._mode === "relay") {
      if (!this.peerPresent) {
        console.log(`[realtime] send DROPPED ${type}: peer not present`);
        return false;
      }
      if (!this.bridgeReady) {
        console.log(`[realtime] send DROPPED ${type}: bridge not ready`);
        return false;
      }
    }

    const envelope = JSON.stringify({
      id: `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      type,
      payload,
    });

    console.log(`[realtime] send ${type}`);

    if (this._mode === "relay" && this.sharedKey) {
      const encrypted = encrypt(envelope, this.sharedKey);
      this.socket.send(encrypted);
    } else {
      this.socket.send(envelope);
    }
    return true;
  }

  cancelTurn(): boolean {
    return this.send("turn.cancel", {});
  }

  startTextTurn(text: string): boolean {
    return this.send("turn.start", { text });
  }

  sendVoiceAudio(base64Audio: string, mimeType: string): boolean {
    return this.send("voice.audio", { data: base64Audio, mimeType });
  }

  acknowledgeNotification(notificationId: string): boolean {
    return this.send("notification.ack", { notificationId });
  }

  // ── Status computation ──────────────────────────────────────────

  private emitStatus(status: ConnectionStatus): void {
    this.statusHandler?.(status);
  }

  private computeAndEmitStatus(): void {
    if (this._mode === "direct") {
      // Direct mode: socket open = connected
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.emitStatus("connected");
      } else if (this.reconnectAttempt > 0) {
        this.emitStatus("reconnecting");
      } else {
        this.emitStatus("disconnected");
      }
      return;
    }

    // Relay mode: need socket + peer + bridge
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.emitStatus(this.reconnectAttempt > 0 ? "reconnecting" : "disconnected");
      return;
    }
    if (!this.peerPresent || !this.bridgeReady) {
      this.emitStatus("reconnecting");
      return;
    }
    this.emitStatus("connected");
  }

  // ── Heartbeat ─────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      // Send ping as raw text frame (NOT encrypted)
      this.socket.send(JSON.stringify({ type: "ping" }));
      // Network handoffs can briefly stall the socket. Require multiple
      // missed pongs before forcing a reconnect.
      if (this.pongTimeoutTimer) clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = setTimeout(() => {
        this.missedPongs += 1;
        console.log(`[realtime] pong timeout ${this.missedPongs}/3`);
        if (this.missedPongs >= 3) {
          console.log(`[realtime] closing socket after missed pongs`);
          this.socket?.close(4001, "pong_timeout");
        }
      }, 12_000);
    }, 20_000);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    if (this.pongTimeoutTimer) { clearTimeout(this.pongTimeoutTimer); this.pongTimeoutTimer = null; }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  // ── Control frame handling (relay mode only) ──────────────────

  /** Returns true if the message was a control frame and was handled. */
  private handleControlFrame(data: string): boolean {
    let parsed: { type: string; [key: string]: unknown };
    try {
      parsed = JSON.parse(data);
      if (typeof parsed.type !== "string") return false;
    } catch {
      return false;
    }

    switch (parsed.type) {
      case "pong":
        // Heartbeat alive — clear timeout
        if (this.pongTimeoutTimer) { clearTimeout(this.pongTimeoutTimer); this.pongTimeoutTimer = null; }
        this.missedPongs = 0;
        // Reset reconnect counter on first pong (proves relay round-trip)
        if (this.reconnectAttempt > 0) {
          this.reconnectAttempt = 0;
        }
        return true;

      case "peer.disconnected": {
        const role = parsed.role as string;
        console.log(`[realtime] peer.disconnected: ${role}`);
        if (role === "host") {
          // Bridge is gone. Close our socket and reconnect to get a clean handshake.
          this.peerPresent = false;
          this.bridgeReady = false;
          this.computeAndEmitStatus();
          // Force reconnect — new client.hello → key exchange → bridge.status
          if (this.socket) {
            this.socket.close(4002, "host_gone");
          }
        }
        return true;
      }

      case "bridge.status": {
        // Any bridge.status proves peer is present (even if ready=false)
        this.peerPresent = true;
        this.bridgeReady = parsed.ready === true;
        console.log(`[realtime] bridge.status ready=${this.bridgeReady}`);
        this.computeAndEmitStatus();
        return true;
      }

      default:
        return false;
    }
  }

  // ── Socket lifecycle ──────────────────────────────────────────

  private openSocket(url: string): void {
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      console.log(`[realtime] socket OPEN mode=${this._mode}`);
      this.missedPongs = 0;

      if (this._mode === "relay" && this.keyPair) {
        // Send client.hello with public key (plaintext, for key exchange)
        socket.send(
          JSON.stringify({
            type: "client.hello",
            payload: {
              clientName: "overwatch-mobile",
              clientPublicKey: toBase64(this.keyPair.publicKey),
            },
          })
        );
        // In relay mode, don't emit "connected" yet — wait for bridge.status
        // Start heartbeat
        this.startHeartbeat();
      } else {
        // Direct mode: connected immediately
        this.send("client.hello", { clientName: "overwatch-mobile" });
        this.emitStatus("connected");
        this.reconnectAttempt = 0;
      }
    };

    socket.onmessage = (event) => {
      try {
        // In relay mode, check for control frames first (plaintext text)
        if (this._mode === "relay" && typeof event.data === "string") {
          if (this.handleControlFrame(event.data)) return;
        }

        if (this._mode === "relay" && this.sharedKey) {
          const data = event.data;
          if (typeof data === "string") {
            // Plaintext JSON that wasn't a control frame
            const envelope = JSON.parse(data) as WsEnvelope;
            this.envelopeHandler?.(envelope);
          } else if (data instanceof ArrayBuffer) {
            const decrypted = decryptToString(
              new Uint8Array(data),
              this.sharedKey
            );
            const envelope = JSON.parse(decrypted) as WsEnvelope;
            console.log(`[realtime] recv: ${envelope.type}`);
            this.envelopeHandler?.(envelope);
          } else if (data instanceof Blob) {
            const sharedKey = this.sharedKey;
            const handler = this.envelopeHandler;
            const reader = new FileReader();
            reader.onload = () => {
              try {
                if (!reader.result || !sharedKey) return;
                const decrypted = decryptToString(
                  new Uint8Array(reader.result as ArrayBuffer),
                  sharedKey
                );
                const envelope = JSON.parse(decrypted) as WsEnvelope;
                console.log(`[realtime] recv: ${envelope.type}`);
                handler?.(envelope);
              } catch (err) {
                console.error(`[realtime] Blob decrypt error:`, err);
              }
            };
            reader.readAsArrayBuffer(data);
          }
        } else {
          // Direct mode: plaintext JSON
          const envelope = JSON.parse(String(event.data)) as WsEnvelope;
          this.envelopeHandler?.(envelope);
        }
      } catch (err) {
        console.error(`[realtime] onmessage error:`, err);
      }
    };

    socket.onerror = (e) => {
      console.error(`[realtime] socket ERROR:`, e);
    };

    socket.onclose = (e) => {
      if (this.socket !== socket) {
        console.log(`[realtime] stale socket CLOSE (ignored)`);
        return;
      }
      console.log(`[realtime] socket CLOSE code=${e.code} reason="${e.reason}"`);
      this.clearHeartbeat();

      if (e.reason === "replaced") {
        this.socket = null;
        return;
      }

      this.socket = null;
      this.peerPresent = false;
      this.bridgeReady = false;

      if (!this.manuallyClosed) {
        const delay = backoffDelay(this.reconnectAttempt);
        this.reconnectAttempt++;
        console.log(`[realtime] reconnect in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})`);
        this.emitStatus("reconnecting");
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this._mode === "relay" && this.relayConfig) {
            this.connectViaRelay(this.relayConfig, true);
          } else if (this.baseURL) {
            this.connect(this.baseURL);
          }
        }, delay);
      } else {
        this.emitStatus("disconnected");
      }
    };
  }
}

export const realtimeClient = new RealtimeClient();

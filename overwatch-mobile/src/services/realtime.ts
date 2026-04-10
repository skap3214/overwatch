import type { WsEnvelope } from "../types";
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
type StatusHandler = (status: "connected" | "disconnected" | "error") => void;

export interface RelayConfig {
  relayUrl: string;
  room: string;
  roomId: string;
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
  return `${wsBase}/api/room/${config.room}/ws/client?roomId=${config.roomId}`;
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

    this.disconnect();
    this.manuallyClosed = false;
    this.currentURL = wsURL;
    this.openSocket(wsURL);
  }

  /** Relay mode: connect via the relay with E2E encryption */
  connectViaRelay(config: RelayConfig, isReconnect = false): void {
    this._mode = "relay";
    this.relayConfig = config;
    this.baseURL = null;

    if (!isReconnect || !this.keyPair || !this.sharedKey) {
      this.keyPair = generateKeyPair();
      const hostPublicKey = fromBase64(config.hostPublicKey);
      this.sharedKey = deriveSharedKey(hostPublicKey, this.keyPair.secretKey);
    }

    const wsURL = toRelayWebSocketURL(config);
    if (this.socket) {
      this.manuallyClosed = true;
      this.socket.close();
      this.socket = null;
    }
    this.manuallyClosed = false;
    this.currentURL = wsURL;
    this.openSocket(wsURL);
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.baseURL = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  /** Send a typed envelope. In relay mode, encrypts before sending. */
  send(type: string, payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const envelope = JSON.stringify({
      id: `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      type,
      payload,
    });

    if (this._mode === "relay" && this.sharedKey) {
      // Send as encrypted binary
      const encrypted = encrypt(envelope, this.sharedKey);
      this.socket.send(encrypted);
    } else {
      this.socket.send(envelope);
    }
  }

  startTextTurn(text: string): void {
    this.send("turn.start", { text });
  }

  /** Send voice audio for STT (relay mode only — goes through CLI bridge) */
  sendVoiceAudio(base64Audio: string, mimeType: string): void {
    this.send("voice.audio", { data: base64Audio, mimeType });
  }

  acknowledgeNotification(notificationId: string): void {
    this.send("notification.ack", { notificationId });
  }

  private openSocket(url: string): void {
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      if (this._mode === "relay" && this.keyPair) {
        socket.send(
          JSON.stringify({
            type: "client.hello",
            payload: {
              clientName: "overwatch-mobile",
              clientPublicKey: toBase64(this.keyPair.publicKey),
            },
          })
        );
      } else {
        // Direct mode: normal hello
        this.send("client.hello", { clientName: "overwatch-mobile" });
      }
      this.statusHandler?.("connected");
    };

    socket.onmessage = (event) => {
      try {
        if (this._mode === "relay" && this.sharedKey) {
          // Could be plaintext (connection.ready before encryption kicks in)
          // or encrypted binary
          const data = event.data;
          if (typeof data === "string") {
            // Plaintext JSON — pre-encryption message
            const envelope = JSON.parse(data) as WsEnvelope;
            this.envelopeHandler?.(envelope);
          } else if (data instanceof ArrayBuffer) {
            // Encrypted binary frame
            const decrypted = decryptToString(
              new Uint8Array(data),
              this.sharedKey
            );
            const envelope = JSON.parse(decrypted) as WsEnvelope;
            this.envelopeHandler?.(envelope);
          } else if (data instanceof Blob) {
            // React Native may deliver as Blob
            const reader = new FileReader();
            reader.onload = () => {
              if (!reader.result || !this.sharedKey) return;
              const decrypted = decryptToString(
                new Uint8Array(reader.result as ArrayBuffer),
                this.sharedKey
              );
              const envelope = JSON.parse(decrypted) as WsEnvelope;
              this.envelopeHandler?.(envelope);
            };
            reader.readAsArrayBuffer(data);
          }
        } else {
          // Direct mode: plaintext JSON
          const envelope = JSON.parse(String(event.data)) as WsEnvelope;
          this.envelopeHandler?.(envelope);
        }
      } catch {
        // ignore malformed messages
      }
    };

    socket.onerror = () => {
      this.statusHandler?.("error");
    };

    socket.onclose = (e) => {
      // "replaced" means the relay replaced us with a newer connection — don't reconnect
      if (e.reason === "replaced") {
        this.socket = null;
        return;
      }
      this.socket = null;
      this.statusHandler?.("disconnected");
      if (!this.manuallyClosed) {
        this.reconnectTimer = setTimeout(() => {
          if (this._mode === "relay" && this.relayConfig) {
            this.connectViaRelay(this.relayConfig, true);
          } else if (this.baseURL) {
            this.connect(this.baseURL);
          }
        }, 2000);
      }
    };
  }
}

export const realtimeClient = new RealtimeClient();

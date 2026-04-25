/**
 * Encrypted bridge: relay WebSocket ↔ local backend WebSocket.
 *
 * The CLI terminates E2E encryption here:
 * - Incoming from relay: decrypt → forward plaintext JSON to backend
 * - Outgoing from backend: encrypt → forward encrypted frame to relay
 * - Special: voice.audio → decrypt → POST to local STT → encrypt voice.transcript → relay
 *
 * Control plane (plaintext text frames, not encrypted):
 * - ping/pong: heartbeat with relay DO
 * - peer.disconnected: relay notifies us when phone dies
 * - bridge.status: we signal readiness (relay+backend both up, key derived) to phone
 */

import WebSocket from "ws";
import {
  generateKeyPair,
  deriveSharedKey,
  encrypt,
  decryptToString,
  toBase64,
  fromBase64,
  type KeyPair,
} from "./crypto.js";

interface BridgeOptions {
  relayUrl: string;
  roomCode: string;
  roomId: string;
  backendPort: number;
  sttUrl: string;
  keyPair?: KeyPair;
  onPhoneConnected: () => void;
  onPhoneDisconnected: () => void;
  onConnected?: (target: "relay" | "backend") => void;
  onReconnecting?: (target: "relay" | "backend") => void;
  onReconnected?: (target: "relay" | "backend") => void;
  onError: (err: Error) => void;
}

function backoff(attempt: number, maxMs: number): number {
  return Math.min(maxMs, 1000 * Math.pow(2, attempt)) + Math.random() * 500;
}

export class RelayBridge {
  private relayWs: WebSocket | null = null;
  private backendWs: WebSocket | null = null;
  private keyPair: KeyPair;
  private sharedKey: Uint8Array | null = null;
  private options: BridgeOptions;
  private isRunning = false;

  // Reconnection state
  private relayReconnectAttempt = 0;
  private relayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backendReconnectAttempt = 0;
  private backendReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Heartbeat state
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private missedPongs = 0;

  // Readiness tracking
  private backendConnected = false;
  private phoneConnected = false;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.keyPair = options.keyPair ?? generateKeyPair();
  }

  get publicKeyBase64(): string {
    return toBase64(this.keyPair.publicKey);
  }

  start(): void {
    this.isRunning = true;
    this.connectToRelay();
    this.connectToBackend();
  }

  stop(): void {
    this.isRunning = false;
    this.clearHeartbeat();
    if (this.relayReconnectTimer) { clearTimeout(this.relayReconnectTimer); this.relayReconnectTimer = null; }
    if (this.backendReconnectTimer) { clearTimeout(this.backendReconnectTimer); this.backendReconnectTimer = null; }
    this.relayWs?.close();
    this.backendWs?.close();
    this.relayWs = null;
    this.backendWs = null;
  }

  // ── Relay connection ──────────────────────────────────────────────

  private connectToRelay(): void {
    const wsUrl = this.options.relayUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");
    const url = `${wsUrl}/api/room/${this.options.roomCode}/ws/host?roomId=${this.options.roomId}&hostPublicKey=${encodeURIComponent(this.publicKeyBase64)}`;

    const ws = new WebSocket(url);
    this.relayWs = ws;

    ws.on("open", () => {
      console.log(`[bridge] relay WebSocket OPEN`);
      this.missedPongs = 0;
      if (this.relayReconnectAttempt > 0) {
        this.options.onReconnected?.("relay");
      } else {
        this.options.onConnected?.("relay");
      }
      // Don't reset attempt counter yet — wait for first pong
      this.startHeartbeat();
      // Send bridge.status if backend is already connected
      this.sendBridgeStatus();
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const text = data.toString("utf-8");
        if (this.handleControlFrame(text)) return;
        // Non-control text frame (client.hello etc)
        this.handleKeyExchange(text);
        return;
      }
      // Encrypted binary frame from phone
      this.handleEncryptedFromPhone(data);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      console.log(`[bridge] relay WebSocket CLOSED: ${code} ${reason.toString()}`);
      this.clearHeartbeat();
      this.relayWs = null;

      if (this.phoneConnected) {
        this.phoneConnected = false;
        this.options.onPhoneDisconnected();
      }

      if (this.isRunning) {
        this.scheduleRelayReconnect();
      }
    });

    ws.on("error", (err: Error) => {
      console.error(`[bridge] relay WebSocket ERROR: ${err.message}`);
    });
  }

  private scheduleRelayReconnect(): void {
    if (this.relayReconnectTimer) return;
    const delay = backoff(this.relayReconnectAttempt, 30_000);
    this.relayReconnectAttempt++;
    console.log(`[bridge] relay reconnect in ${Math.round(delay)}ms (attempt ${this.relayReconnectAttempt})`);
    this.options.onReconnecting?.("relay");
    this.relayReconnectTimer = setTimeout(() => {
      this.relayReconnectTimer = null;
      if (this.isRunning) this.connectToRelay();
    }, delay);
  }

  // ── Backend connection ────────────────────────────────────────────

  private connectToBackend(): void {
    const url = `ws://localhost:${this.options.backendPort}/api/v1/ws`;
    const ws = new WebSocket(url);
    this.backendWs = ws;

    ws.on("open", () => {
      console.log(`[bridge] backend WebSocket OPEN`);
      this.backendConnected = true;
      if (this.backendReconnectAttempt > 0) {
        this.options.onReconnected?.("backend");
        this.backendReconnectAttempt = 0;
      } else {
        this.options.onConnected?.("backend");
      }
      // Send hello to backend
      ws.send(
        JSON.stringify({
          id: `cli_${Date.now()}`,
          createdAt: new Date().toISOString(),
          type: "client.hello",
          payload: { clientName: "overwatch-cli-bridge" },
        })
      );
      // Notify phone of readiness
      this.sendBridgeStatus();
    });

    ws.on("message", (data: Buffer) => {
      // Backend sends plaintext JSON → encrypt and forward to relay
      if (!this.sharedKey || !this.relayWs) {
        return;
      }
      const text = data.toString("utf-8");
      try {
        const env = JSON.parse(text);
        console.log(`[bridge] backend→relay: ${env.type}`);
      } catch {}
      const encrypted = encrypt(text, this.sharedKey);
      try { this.relayWs.send(encrypted); } catch {}
    });

    ws.on("close", () => {
      console.log(`[bridge] backend WebSocket CLOSED`);
      this.backendConnected = false;
      this.backendWs = null;
      // Notify phone that backend is down
      this.sendBridgeStatus();

      if (this.isRunning) {
        this.scheduleBackendReconnect();
      }
    });

    ws.on("error", (err: Error) => {
      console.error(`[bridge] backend WebSocket ERROR: ${err.message}`);
    });
  }

  private scheduleBackendReconnect(): void {
    if (this.backendReconnectTimer) return;
    const delay = backoff(this.backendReconnectAttempt, 15_000);
    this.backendReconnectAttempt++;
    console.log(`[bridge] backend reconnect in ${Math.round(delay)}ms (attempt ${this.backendReconnectAttempt})`);
    this.options.onReconnecting?.("backend");
    this.backendReconnectTimer = setTimeout(() => {
      this.backendReconnectTimer = null;
      if (this.isRunning) this.connectToBackend();
    }, delay);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.pingInterval = setInterval(() => {
      if (!this.relayWs || this.relayWs.readyState !== WebSocket.OPEN) return;
      this.relayWs.send(JSON.stringify({ type: "ping" }));
      // Close only after multiple misses. Mobile and Cloudflare sockets can
      // stall briefly during network switches without being truly dead.
      if (this.pongTimeoutTimer) clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = setTimeout(() => {
        this.missedPongs += 1;
        console.log(`[bridge] pong timeout ${this.missedPongs}/3`);
        if (this.missedPongs >= 3) {
          console.log(`[bridge] closing relay socket after missed pongs`);
          this.relayWs?.close(4001, "pong_timeout");
        }
      }, 12_000);
    }, 20_000);
  }

  private clearHeartbeat(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    if (this.pongTimeoutTimer) { clearTimeout(this.pongTimeoutTimer); this.pongTimeoutTimer = null; }
  }

  // ── Control frame handling ────────────────────────────────────────

  private handleControlFrame(text: string): boolean {
    let parsed: { type: string; [key: string]: unknown };
    try {
      parsed = JSON.parse(text);
      if (typeof parsed.type !== "string") return false;
    } catch {
      return false;
    }

    switch (parsed.type) {
      case "pong":
        // Pong from relay — heartbeat alive
        if (this.pongTimeoutTimer) { clearTimeout(this.pongTimeoutTimer); this.pongTimeoutTimer = null; }
        this.missedPongs = 0;
        // Reset reconnect counter on first pong (proves round-trip)
        if (this.relayReconnectAttempt > 0) {
          this.relayReconnectAttempt = 0;
        }
        return true;

      case "peer.disconnected": {
        const role = parsed.role as string;
        console.log(`[bridge] peer.disconnected: ${role}`);
        if (role === "client") {
          // Phone disconnected
          this.phoneConnected = false;
          this.sharedKey = null; // Phone will re-handshake on reconnect
          this.options.onPhoneDisconnected();
        }
        return true;
      }

      default:
        return false;
    }
  }

  // ── Bridge status signaling ───────────────────────────────────────

  private sendBridgeStatus(): void {
    if (!this.relayWs || this.relayWs.readyState !== WebSocket.OPEN) return;
    const ready = this.backendConnected && this.sharedKey !== null;
    try {
      this.relayWs.send(JSON.stringify({
        type: "bridge.status",
        ready,
      }));
      console.log(`[bridge] sent bridge.status ready=${ready}`);
    } catch {}
  }

  // ── Key exchange ──────────────────────────────────────────────────

  private handleKeyExchange(message: string): void {
    try {
      const envelope = JSON.parse(message);
      if (envelope.type === "client.hello" && envelope.payload?.clientPublicKey) {
        const clientPublicKey = fromBase64(envelope.payload.clientPublicKey);
        this.sharedKey = deriveSharedKey(clientPublicKey, this.keyPair.secretKey);
        this.phoneConnected = true;
        this.options.onPhoneConnected();
        // Send bridge.status now that we have the shared key
        this.sendBridgeStatus();
      }
    } catch {
      // Not a valid key exchange message
    }
  }

  // ── Encrypted message handling ────────────────────────────────────

  private handleEncryptedFromPhone(data: Buffer): void {
    if (!this.sharedKey) return;

    let plaintext: string;
    try {
      plaintext = decryptToString(new Uint8Array(data), this.sharedKey);
    } catch (err) {
      console.error("[bridge] Decryption failed:", err);
      return;
    }

    let envelope: { type: string; payload?: any };
    try {
      envelope = JSON.parse(plaintext);
    } catch {
      this.backendWs?.send(plaintext);
      return;
    }

    console.log(`[bridge] phone→backend: ${envelope.type}`);

    // Special handling: voice.audio → local STT
    if (envelope.type === "voice.audio") {
      this.handleVoiceAudio(envelope.payload);
      return;
    }

    // Everything else: forward to backend
    this.backendWs?.send(plaintext);
  }

  private async handleVoiceAudio(payload: {
    data: string;
    mimeType: string;
  }): Promise<void> {
    try {
      const audioBytes = fromBase64(payload.data);
      console.log(`[bridge] STT: ${audioBytes.length} bytes, mime: ${payload.mimeType}`);

      const res = await fetch(this.options.sttUrl, {
        method: "POST",
        headers: { "Content-Type": payload.mimeType || "audio/wav" },
        body: Buffer.from(audioBytes),
      });

      console.log(`[bridge] STT response: ${res.status}`);
      const json = (await res.json()) as { transcript?: string; error?: string };
      console.log(`[bridge] STT result: ${JSON.stringify(json).slice(0, 200)}`);

      if (!res.ok || !json.transcript?.trim()) {
        this.sendEncryptedToPhone({
          type: "voice.error",
          payload: { message: json.error || "No speech detected" },
        });
        return;
      }

      this.sendEncryptedToPhone({
        type: "voice.transcript",
        payload: { text: json.transcript.trim() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "STT failed";
      this.sendEncryptedToPhone({
        type: "voice.error",
        payload: { message: msg },
      });
    }
  }

  private sendEncryptedToPhone(envelope: object): void {
    if (!this.sharedKey || !this.relayWs) return;
    const json = JSON.stringify({
      id: `bridge_${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...envelope,
    });
    const encrypted = encrypt(json, this.sharedKey);
    try { this.relayWs.send(encrypted); } catch {}
  }
}

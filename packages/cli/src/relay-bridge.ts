/**
 * Encrypted bridge: relay WebSocket ↔ local backend WebSocket.
 *
 * The CLI terminates E2E encryption here:
 * - Incoming from relay: decrypt → forward plaintext JSON to backend
 * - Outgoing from backend: encrypt → forward encrypted frame to relay
 * - Special: voice.audio → decrypt → POST to local STT → encrypt voice.transcript → relay
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
  onPhoneConnected: () => void;
  onPhoneDisconnected: () => void;
  onError: (err: Error) => void;
}

export class RelayBridge {
  private relayWs: WebSocket | null = null;
  private backendWs: WebSocket | null = null;
  private keyPair: KeyPair;
  private sharedKey: Uint8Array | null = null;
  private options: BridgeOptions;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.keyPair = generateKeyPair();
  }

  get publicKeyBase64(): string {
    return toBase64(this.keyPair.publicKey);
  }

  start(): void {
    this.connectToRelay();
    this.connectToBackend();
  }

  stop(): void {
    this.relayWs?.close();
    this.backendWs?.close();
    this.relayWs = null;
    this.backendWs = null;
  }

  private connectToRelay(): void {
    const wsUrl = this.options.relayUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");
    const url = `${wsUrl}/api/room/${this.options.roomCode}/ws/host?roomId=${this.options.roomId}`;

    this.relayWs = new WebSocket(url);

    this.relayWs.on("open", () => {
      console.log(`[bridge] relay WebSocket OPEN`);
    });

    this.relayWs.on("message", (data: Buffer, isBinary: boolean) => {
      console.log(`[bridge] relay message: binary=${isBinary} len=${data.length}`);
      if (!isBinary) {
        // Plaintext text frame — key exchange
        const text = data.toString("utf-8");
        console.log(`[bridge] relay text: ${text.slice(0, 200)}`);
        this.handleKeyExchange(text);
        return;
      }
      // Encrypted binary frame
      this.handleEncryptedFromPhone(data);
    });

    this.relayWs.on("close", (code: number, reason: Buffer) => {
      console.log(`[bridge] relay WebSocket CLOSED: ${code} ${reason.toString()}`);
      this.options.onPhoneDisconnected();
    });

    this.relayWs.on("error", (err: Error) => {
      console.error(`[bridge] relay WebSocket ERROR: ${err.message}`);
      this.options.onError(err);
    });
  }

  private connectToBackend(): void {
    const url = `ws://localhost:${this.options.backendPort}/api/v1/ws`;
    this.backendWs = new WebSocket(url);

    this.backendWs.on("open", () => {
      // Send hello to backend as if we're a normal client
      this.backendWs!.send(
        JSON.stringify({
          id: `cli_${Date.now()}`,
          createdAt: new Date().toISOString(),
          type: "client.hello",
          payload: { clientName: "overwatch-cli-bridge" },
        })
      );
    });

    this.backendWs.on("message", (data: Buffer) => {
      // Backend sends plaintext JSON → encrypt and forward to relay
      if (!this.sharedKey || !this.relayWs) {
        console.warn(`[bridge] dropping backend msg: sharedKey=${!!this.sharedKey} relayWs=${!!this.relayWs}`);
        return;
      }
      const text = data.toString("utf-8");
      try {
        const env = JSON.parse(text);
        console.log(`[bridge] backend→relay: ${env.type}`);
      } catch {}
      const encrypted = encrypt(text, this.sharedKey);
      this.relayWs.send(encrypted);
    });

    this.backendWs.on("error", (err: Error) => {
      this.options.onError(new Error(`Backend WebSocket error: ${err.message}`));
    });
  }

  private handleKeyExchange(message: string): void {
    try {
      const envelope = JSON.parse(message);
      if (envelope.type === "client.hello" && envelope.payload?.clientPublicKey) {
        const clientPublicKey = fromBase64(envelope.payload.clientPublicKey);
        this.sharedKey = deriveSharedKey(clientPublicKey, this.keyPair.secretKey);
        this.options.onPhoneConnected();
      }
    } catch {
      // Not a valid key exchange message
    }
  }

  private handleEncryptedFromPhone(data: Buffer): void {
    if (!this.sharedKey) return;

    let plaintext: string;
    try {
      plaintext = decryptToString(new Uint8Array(data), this.sharedKey);
    } catch (err) {
      console.error("[bridge] Decryption failed:", err);
      return;
    }

    // Parse the envelope to check for special types
    let envelope: { type: string; payload?: any };
    try {
      envelope = JSON.parse(plaintext);
    } catch {
      // Forward as-is
      this.backendWs?.send(plaintext);
      return;
    }

    // Special handling: voice.audio → local STT
    if (envelope.type === "voice.audio") {
      console.log(`[bridge] voice.audio received, data length: ${envelope.payload?.data?.length ?? 0}`);
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
      // Decode base64 audio
      const audioBytes = fromBase64(payload.data);
      console.log(`[bridge] STT: ${audioBytes.length} bytes, mime: ${payload.mimeType}`);

      // POST to local STT endpoint
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

      // Send transcript back to phone
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
    this.relayWs.send(encrypted);
  }
}

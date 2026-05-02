/**
 * Adapter-protocol server. Connects outbound to the relay as a WebSocket
 * client, registers as the daemon for this user, and handles HarnessCommands
 * from the cloud orchestrator. Streams HarnessEvents back through the same
 * channel.
 *
 * Wire format: envelope-wrapped JSON (see /protocol/schema/envelope.schema.json).
 * Encryption: re-uses the existing nacl.box per-pair scheme; orchestrator and
 * daemon both encrypt with the user's keypair when passing through the relay.
 *
 * This implementation focuses on the orchestrator-facing surface. Encryption
 * concerns live in the relay-client module (existing).
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Envelope,
  HarnessCommand,
  HarnessEvent,
} from "@overwatch/shared/protocol";
import { PROTOCOL_VERSION } from "@overwatch/shared/protocol";
import type { OrchestratorHarness } from "../harness/types.js";
import type { AdapterEvent } from "../shared/events.js";
import {
  COMMAND_ALLOWLIST,
  type AdapterProtocolDeps,
  type CommandKind,
} from "./types.js";
import { createTokenValidator, type TokenValidator } from "./token-validator.js";
import { AuditLog } from "./audit-log.js";
import { StaleSuppression } from "./stale-suppression.js";
import { CancellationRegistry } from "./cancellation.js";

const require = createRequire(import.meta.url);
const wsLib = require("ws") as any;
const WebSocketCtor: any = wsLib.WebSocket ?? wsLib.default ?? wsLib;

interface AdapterProtocolServerOptions {
  deps: AdapterProtocolDeps;
  /** Map of provider id → harness instance. */
  harnesses: Record<string, OrchestratorHarness>;
}

/**
 * Wraps an AdapterEvent (no routing fields) into a wire-protocol HarnessEvent
 * (with correlation_id + target stamped on).
 */
function stampEvent(
  event: AdapterEvent,
  correlation_id: string,
  target: string,
): HarnessEvent {
  return { ...event, correlation_id, target } as HarnessEvent;
}

export class AdapterProtocolServer {
  private socket: any | null = null;
  private readonly tokens: TokenValidator;
  private readonly audit: AuditLog;
  private readonly stale = new StaleSuppression();
  private readonly registry = new CancellationRegistry();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: AdapterProtocolServerOptions) {
    this.tokens = createTokenValidator(opts.deps.pairingToken || "alpha-placeholder");
    this.audit = new AuditLog(opts.deps.auditLogPath);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.opts.deps.relayUrl;
    if (!url) {
      console.warn("[adapter-protocol] no RELAY_URL configured; skipping connect");
      return;
    }

    try {
      this.socket = new WebSocketCtor(url);
    } catch (err) {
      console.warn("[adapter-protocol] socket construction failed:", err);
      this.scheduleReconnect();
      return;
    }

    this.socket.on("open", () => {
      console.log(`[adapter-protocol] connected to relay at ${url}`);
      // The relay's existing pairing protocol handles authn; we send a daemon-
      // ready envelope after socket open so the relay can route orchestrator
      // commands here.
      this.send({
        protocol_version: PROTOCOL_VERSION,
        kind: "server_message",
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          type: "harness_state",
          active_target: Object.keys(this.opts.harnesses)[0] ?? "",
          in_flight: false,
        },
      });
    });

    this.socket.on("message", (raw: Buffer | string) => {
      this.onMessage(raw.toString());
    });

    this.socket.on("close", () => {
      this.socket = null;
      this.scheduleReconnect();
    });

    this.socket.on("error", (err: Error) => {
      console.warn("[adapter-protocol] socket error:", err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
    this.reconnectTimer.unref();
  }

  private send(envelope: Envelope): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    try {
      this.socket.send(JSON.stringify(envelope));
    } catch (err) {
      console.warn("[adapter-protocol] send failed:", err);
    }
  }

  private async onMessage(raw: string): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return; // ignore non-JSON
    }
    if (envelope.kind !== "harness_command") return;

    // Token validation.
    const sessionToken = envelope.session_token;
    if (!sessionToken) {
      this.respondError(envelope, "missing session_token");
      return;
    }
    const claims = this.tokens.verify(sessionToken);
    if (!claims) {
      this.respondError(envelope, "invalid or expired session_token");
      return;
    }

    const command = envelope.payload as unknown as HarnessCommand;
    if (!command || typeof command !== "object" || !command.kind) {
      this.respondError(envelope, "missing command kind");
      return;
    }

    // Allowlist check.
    if (!COMMAND_ALLOWLIST.has(command.kind as CommandKind)) {
      this.audit.append(command, claims.session_id, "rejected", "kind not allowlisted");
      this.respondError(envelope, `command kind '${command.kind}' not allowed`);
      return;
    }

    this.audit.append(command, claims.session_id, "accepted");

    try {
      switch (command.kind) {
        case "submit_text":
          await this.handleSubmitText(command);
          break;
        case "submit_with_steer":
          await this.handleSubmitWithSteer(command);
          break;
        case "cancel":
          await this.handleCancel(command);
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      this.respondError(envelope, message);
    }
  }

  private respondError(envelope: Envelope, message: string): void {
    this.send({
      protocol_version: PROTOCOL_VERSION,
      kind: "server_message",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        type: "error_response",
        request_id: envelope.id,
        error: { code: "adapter-protocol", message },
      },
    });
  }

  private resolveHarness(target: string): OrchestratorHarness | null {
    return this.opts.harnesses[target] ?? null;
  }

  private async handleSubmitText(cmd: HarnessCommand): Promise<void> {
    if (cmd.kind !== "submit_text") return;
    const harness = this.resolveHarness(cmd.target);
    if (!harness) {
      this.emitError(cmd.correlation_id, cmd.target, `unknown target: ${cmd.target}`);
      return;
    }
    await this.runHarnessTurn(harness, cmd.correlation_id, cmd.target, cmd.payload.text);
  }

  private async handleSubmitWithSteer(cmd: HarnessCommand): Promise<void> {
    if (cmd.kind !== "submit_with_steer") return;
    const harness = this.resolveHarness(cmd.target);
    if (!harness) {
      this.emitError(cmd.correlation_id, cmd.target, `unknown target: ${cmd.target}`);
      return;
    }

    // Cancel the in-flight turn first.
    const cancelTarget = cmd.payload.cancels_correlation_id;
    if (cancelTarget) {
      this.stale.markCancelled(cancelTarget);
      try {
        await this.registry.cancel(cancelTarget);
        // Forward cancel_confirmed to orchestrator.
        this.sendEvent({
          type: "cancel_confirmed",
          correlation_id: cancelTarget,
          target: cmd.target,
        });
      } catch {
        // cancel_failed — surface as an error event but proceed with the new turn.
        this.emitError(cancelTarget, cmd.target, "cancel_confirmed timeout");
      }
    }

    await this.runHarnessTurn(harness, cmd.correlation_id, cmd.target, cmd.payload.text);
  }

  private async handleCancel(cmd: HarnessCommand): Promise<void> {
    if (cmd.kind !== "cancel") return;
    const target = cmd.payload.target_correlation_id;
    this.stale.markCancelled(target);
    try {
      await this.registry.cancel(target);
      this.sendEvent({
        type: "cancel_confirmed",
        correlation_id: target,
        target: cmd.target,
      });
    } catch {
      this.emitError(target, cmd.target, "cancel_confirmed timeout");
    }
  }

  private async runHarnessTurn(
    harness: OrchestratorHarness,
    correlation_id: string,
    target: string,
    prompt: string,
  ): Promise<void> {
    const turn = this.registry.register(correlation_id);
    try {
      for await (const adapterEvent of harness.runTurn({
        prompt,
        correlation_id,
        abortSignal: turn.abortController.signal,
      })) {
        if (this.stale.isStale(correlation_id)) {
          if (adapterEvent.type === "cancel_confirmed") {
            this.registry.confirmCancel(correlation_id);
            this.sendEvent(stampEvent(adapterEvent, correlation_id, target));
          }
          // Drop everything else.
          continue;
        }

        if (adapterEvent.type === "cancel_confirmed") {
          this.registry.confirmCancel(correlation_id);
        }
        this.sendEvent(stampEvent(adapterEvent, correlation_id, target));
      }
    } finally {
      this.registry.unregister(correlation_id);
    }
  }

  private sendEvent(event: HarnessEvent): void {
    this.send({
      protocol_version: PROTOCOL_VERSION,
      kind: "harness_event",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      payload: event as unknown as Record<string, unknown>,
    });
  }

  private emitError(correlation_id: string, target: string, message: string): void {
    this.sendEvent({
      type: "error",
      correlation_id,
      target,
      message,
      raw: undefined,
    });
    this.sendEvent({
      type: "session_end",
      correlation_id,
      target,
      subtype: "error",
      result: message,
      raw: undefined,
    });
  }
}

// Re-exports
export { delay };

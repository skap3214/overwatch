/**
 * Adapter-protocol server. Connects outbound to the relay as a WebSocket
 * client, registers as the daemon for this user, and handles HarnessCommands
 * from the cloud orchestrator. Streams HarnessEvents back through the same
 * channel.
 *
 * Wire format: envelope-wrapped JSON (see /protocol/schema/envelope.schema.json).
 *
 * Auth: each command envelope carries a per-session HMAC token that the phone
 * derived from the shared pairing_token. We verify HMAC + expiry via
 * TokenValidator before handling any command. The transport itself is plain
 * TLS-terminated WebSocket — the relay's UserChannel keeps phone/orchestrator/
 * daemon traffic separated per-user; there is no symmetric e2e encryption on
 * top of TLS.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Envelope,
  HarnessCommand,
  HarnessEvent,
  MonitorActionMetadata,
  MonitorActionResult,
  ServerMessage,
  ScheduledMonitor as WireScheduledMonitor,
} from "@overwatch/shared/protocol";
import { PROTOCOL_VERSION } from "@overwatch/shared/protocol";
import type { OrchestratorHarness } from "../harness/types.js";
import type { AdapterEvent } from "../shared/events.js";
import { getCapabilities } from "../harness/capabilities.js";
import { listProviders } from "../harness/providers/index.js";
import {
  createScheduledTask,
  deleteScheduledTask,
  type ScheduledMonitor,
} from "../extensions/scheduler.js";
import type { MonitorSource } from "../scheduler/monitor-source.js";
import type { HermesJobsBridge } from "../scheduler/hermes-jobs-bridge.js";
import type { HermesSkillsBridge } from "../scheduler/hermes-skills-bridge.js";
import {
  listJobRuns,
  readJobRunOutput,
  summarizeOutput,
} from "../scheduler/hermes-job-runs.js";
import {
  COMMAND_ALLOWLIST,
  type AdapterProtocolDeps,
  type CommandKind,
} from "./types.js";
import { createTokenValidator, type TokenValidator } from "./token-validator.js";
import { AuditLog } from "./audit-log.js";
import { StaleSuppression } from "./stale-suppression.js";
import { CancellationRegistry } from "./cancellation.js";
import { createCatchAllLogger, type CatchAllLogger } from "./catch-all-logger.js";
import {
  notificationStore,
  type NotificationEvent,
} from "../notifications/store.js";

const require = createRequire(import.meta.url);
const wsLib = require("ws") as any;
const WebSocketCtor: any = wsLib.WebSocket ?? wsLib.default ?? wsLib;

interface AdapterProtocolServerOptions {
  deps: AdapterProtocolDeps;
  /** Map of provider id → harness instance. */
  harnesses: Record<string, OrchestratorHarness>;
  /** Configured provider id, e.g. "pi-coding-agent", "claude-code-cli", "hermes". */
  activeProviderId: string;
  /** Active provider namespace used by harness events, e.g. "pi", "claude-code", "hermes". */
  activeTarget: string;
  monitorSource: MonitorSource;
  hermesJobsBridge?: HermesJobsBridge | null;
  hermesSkillsBridge?: HermesSkillsBridge | null;
  hermesBaseURL?: string;
  hermesApiKey?: string;
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function notificationToServerMessage(notification: NotificationEvent): ServerMessage {
  return {
    type: "notification",
    id: notification.id,
    title: notification.title,
    body: notification.body,
    kind: notification.kind,
    created_at: notification.createdAt,
    speakable_text: notification.speakableText,
    status: notification.status,
    source: notification.source,
    metadata: notification.metadata,
  };
}

function toWireMonitor(monitor: ScheduledMonitor): WireScheduledMonitor {
  return { ...monitor } as WireScheduledMonitor;
}

function majorVersion(version: string): string {
  const dot = version.indexOf(".");
  return dot === -1 ? version : version.slice(0, dot);
}

export class AdapterProtocolServer {
  private socket: any | null = null;
  private readonly tokens: TokenValidator;
  private readonly audit: AuditLog;
  private readonly stale = new StaleSuppression();
  private readonly registry = new CancellationRegistry();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly catchAllLoggers = new Map<string, CatchAllLogger>();
  private notificationsUnsubscribe: (() => void) | null = null;
  private monitorUnsubscribe: (() => void) | null = null;
  private skillsUnsubscribe: (() => void) | null = null;
  /**
   * Per-target active correlation id. Enforces the protocol's busy
   * invariant: `submit_text` must be rejected when the target is already
   * running a turn. Only `submit_with_steer` may preempt.
   */
  private readonly activeByTarget = new Map<string, string>();

  constructor(private readonly opts: AdapterProtocolServerOptions) {
    this.tokens = createTokenValidator(opts.deps.pairingToken || "alpha-placeholder");
    this.audit = new AuditLog(opts.deps.auditLogPath);
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.notificationsUnsubscribe = notificationStore.subscribe((notification) => {
      this.emitNotificationEvent(notification);
      this.emitNotificationSnapshot(notification);
    });
    this.monitorUnsubscribe = this.opts.monitorSource.subscribe((monitors) => {
      this.emitMonitorSnapshot(monitors);
    });
    this.skillsUnsubscribe =
      this.opts.hermesSkillsBridge?.subscribe((skills) => {
        this.emitSkillsSnapshot(skills);
      }) ?? null;
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
    if (this.notificationsUnsubscribe) {
      this.notificationsUnsubscribe();
      this.notificationsUnsubscribe = null;
    }
    if (this.monitorUnsubscribe) {
      this.monitorUnsubscribe();
      this.monitorUnsubscribe = null;
    }
    if (this.skillsUnsubscribe) {
      this.skillsUnsubscribe();
      this.skillsUnsubscribe = null;
    }
  }

  private getCatchAllLogger(provider: string): CatchAllLogger {
    let logger = this.catchAllLoggers.get(provider);
    if (!logger) {
      logger = createCatchAllLogger(provider, this.opts.deps.catchAllLoggerEnabled);
      this.catchAllLoggers.set(provider, logger);
    }
    return logger;
  }

  private emitNotificationEvent(notification: NotificationEvent): void {
    // Surface scheduler/system notifications to the orchestrator as a Tier-2
    // provider_event. Routed by HARNESS_EVENT_CONFIGS["overwatch/notification"]
    // (speak), so the user hears the speakable text on their next idle moment.
    const target = Object.keys(this.opts.harnesses)[0] ?? "claude-code";
    const message =
      notification.speakableText ?? notification.body ?? notification.title;
    this.sendEvent({
      type: "provider_event",
      correlation_id: `notif-${notification.id}`,
      target,
      provider: "overwatch",
      kind: "notification",
      payload: {
        notification_id: notification.id,
        notification_kind: notification.kind,
        title: notification.title,
        body: notification.body,
        message,
        speakable_text: notification.speakableText,
        source: notification.source,
        metadata: notification.metadata,
      },
      raw: notification as unknown as Record<string, unknown>,
    });
  }

  private emitNotificationSnapshot(notification: NotificationEvent): void {
    this.sendServerMessage(notificationToServerMessage(notification));
  }

  private connect(): void {
    if (this.stopped) return;
    const { relayUrl, userId, pairingToken } = this.opts.deps;
    if (!relayUrl || !userId || !pairingToken) {
      console.warn(
        "[adapter-protocol] missing relayUrl/userId/pairingToken; skipping connect",
      );
      return;
    }

    const wsBase = relayUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://")
      .replace(/\/+$/, "");
    const url = `${wsBase}/api/users/${encodeURIComponent(userId)}/ws/host?token=${encodeURIComponent(pairingToken)}`;

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
      this.emitHarnessState();
      this.emitHarnessSnapshot();
      void this.emitInitialUiSnapshots();
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

  private sendServerMessage(payload: ServerMessage): void {
    this.send({
      protocol_version: PROTOCOL_VERSION,
      kind: "server_message",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  private emitHarnessState(): void {
    this.sendServerMessage({
      type: "harness_state",
      active_target: this.opts.activeTarget,
      in_flight: this.activeByTarget.size > 0,
      active_correlation_id: this.firstActiveCorrelationId() ?? undefined,
    });
  }

  private emitHarnessSnapshot(): void {
    this.sendServerMessage({
      type: "harness_snapshot",
      active_provider_id: this.opts.activeProviderId,
      active_target: this.opts.activeTarget,
      capabilities: getCapabilities(this.opts.activeProviderId),
      providers: listProviders(),
      in_flight: this.activeByTarget.size > 0,
      active_correlation_id: this.firstActiveCorrelationId() ?? undefined,
    });
  }

  private async emitInitialUiSnapshots(): Promise<void> {
    this.emitMonitorSnapshot(await this.opts.monitorSource.list());
    this.emitSkillsSnapshot(this.opts.hermesSkillsBridge?.list() ?? []);
    for (const notification of notificationStore.list(20).reverse()) {
      this.emitNotificationSnapshot(notification);
    }
  }

  private emitMonitorSnapshot(monitors: ScheduledMonitor[]): void {
    this.sendServerMessage({
      type: "monitor_snapshot",
      monitors: monitors.map(toWireMonitor),
      actions: this.monitorActionMetadata(),
    });
  }

  private emitSkillsSnapshot(skills: Array<{ name: string; description: string; category: string; enabled: boolean; version?: string }>): void {
    this.sendServerMessage({
      type: "skills_snapshot",
      provider_id: this.opts.activeProviderId,
      skills,
    });
  }

  private firstActiveCorrelationId(): string | null {
    for (const id of this.activeByTarget.values()) return id;
    return null;
  }

  private monitorActionMetadata(): MonitorActionMetadata {
    const isHermes = this.opts.activeProviderId === "hermes";
    if (isHermes) {
      return {
        source: "hermes",
        provider_id: this.opts.activeProviderId,
        can_create: true,
        can_edit: true,
        can_delete: true,
        can_pause: true,
        can_resume: true,
        can_run_now: true,
        supports_run_history: true,
      };
    }
    return {
      source: "local",
      provider_id: this.opts.activeProviderId,
      can_create: true,
      can_edit: false,
      can_delete: true,
      can_pause: false,
      can_resume: false,
      can_run_now: false,
      supports_run_history: false,
      unsupported_reason:
        "Overwatch-local monitors can be created and deleted, but local cron execution is not wired in this daemon.",
    };
  }

  private async onMessage(raw: string): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return; // ignore non-JSON
    }

    // Protocol-version handshake: refuse mismatched majors. We respond with an
    // explicit error so the orchestrator surfaces the mismatch instead of
    // hanging waiting for a response.
    const wireVersion = envelope.protocol_version;
    if (
      typeof wireVersion === "string" &&
      majorVersion(wireVersion) !== majorVersion(PROTOCOL_VERSION)
    ) {
      this.respondError(
        envelope,
        `protocol version mismatch: wire=${wireVersion} local=${PROTOCOL_VERSION}`,
      );
      return;
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
        case "manage_monitor":
          await this.handleManageMonitor(command);
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
    const direct = this.opts.harnesses[target];
    if (direct) return direct;
    // Fallback: single-harness-per-daemon today; if the orchestrator's
    // default target doesn't match the configured provider id (e.g. bot.py
    // defaults to "claude-code" but the daemon is running Hermes), route
    // to the active harness. The active provider id is surfaced via
    // /health and the daemon's harness_state snapshot on connect.
    const keys = Object.keys(this.opts.harnesses);
    if (keys.length === 1) return this.opts.harnesses[keys[0]];
    return null;
  }

  private async handleSubmitText(cmd: HarnessCommand): Promise<void> {
    if (cmd.kind !== "submit_text") return;
    const harness = this.resolveHarness(cmd.target);
    if (!harness) {
      this.emitError(cmd.correlation_id, cmd.target, `unknown target: ${cmd.target}`);
      return;
    }
    // Protocol invariant: submit_text must be rejected when the target is
    // already running a turn. Use submit_with_steer to preempt.
    const active = this.activeByTarget.get(cmd.target);
    if (active) {
      this.emitError(
        cmd.correlation_id,
        cmd.target,
        `target ${cmd.target} busy with correlation_id ${active} — use submit_with_steer to preempt`,
      );
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
      // Whether cancel confirmed or timed out, the prior correlation no
      // longer occupies the target.
      if (this.activeByTarget.get(cmd.target) === cancelTarget) {
        this.activeByTarget.delete(cmd.target);
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

  private async handleManageMonitor(cmd: HarnessCommand): Promise<void> {
    if (cmd.kind !== "manage_monitor") return;
    const { request_id, action } = cmd.payload;
    try {
      const result = await this.runMonitorAction(cmd);
      this.sendMonitorActionResult({
        request_id,
        action,
        ok: true,
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      this.sendMonitorActionResult({
        request_id,
        action,
        ok: false,
        error: { code: "monitor_action_failed", message },
      });
    }
    this.emitMonitorSnapshot(await this.opts.monitorSource.list());
  }

  private sendMonitorActionResult(result: Omit<MonitorActionResult, "type">): void {
    this.sendServerMessage({
      type: "monitor_action_result",
      ...result,
    });
  }

  private async runMonitorAction(
    cmd: Extract<HarnessCommand, { kind: "manage_monitor" }>
  ): Promise<Partial<MonitorActionResult>> {
    const isHermes = this.opts.activeProviderId === "hermes";
    if (isHermes) return this.runHermesMonitorAction(cmd);
    return this.runLocalMonitorAction(cmd);
  }

  private async runLocalMonitorAction(
    cmd: Extract<HarnessCommand, { kind: "manage_monitor" }>
  ): Promise<Partial<MonitorActionResult>> {
    const { action, monitor_id, input } = cmd.payload;
    if (action === "list") {
      return { monitors: (await this.opts.monitorSource.list()).map(toWireMonitor) };
    }
    if (action === "get") {
      const monitor = (await this.opts.monitorSource.list()).find((item) => item.id === monitor_id);
      if (!monitor) throw new Error(`Monitor not found: ${monitor_id ?? "<missing>"}`);
      return { monitor: toWireMonitor(monitor) };
    }
    if (action === "create") {
      const title = asString(input?.title ?? input?.description) ?? "Scheduled monitor";
      const prompt = asString(input?.prompt) ?? asString(input?.instructions);
      if (!prompt) throw new Error("Local monitor creation requires a prompt.");
      const schedule = asString(input?.schedule ?? input?.interval ?? input?.cron);
      if (!schedule) throw new Error("Local monitor creation requires a schedule.");
      const normalized = schedule.replace(/^every\s+/i, "").trim();
      createScheduledTask({
        prompt,
        description: title,
        interval: /^\d+[smhd]$/.test(normalized) ? normalized : undefined,
        cron: /^\d+[smhd]$/.test(normalized) ? undefined : normalized,
        recurring: input?.recurring === false ? false : true,
      });
      return { monitors: (await this.opts.monitorSource.list()).map(toWireMonitor) };
    }
    if (action === "delete") {
      if (!monitor_id) throw new Error("Delete requires monitor_id.");
      const removed = deleteScheduledTask(monitor_id);
      if (!removed) throw new Error(`Monitor not found: ${monitor_id}`);
      return { monitors: (await this.opts.monitorSource.list()).map(toWireMonitor) };
    }
    throw new Error(`Action '${action}' is not supported for Overwatch-local monitors.`);
  }

  private async runHermesMonitorAction(
    cmd: Extract<HarnessCommand, { kind: "manage_monitor" }>
  ): Promise<Partial<MonitorActionResult>> {
    const { action, monitor_id, run_id, input } = cmd.payload;
    const baseURL = this.opts.hermesBaseURL;
    const apiKey = this.opts.hermesApiKey;
    if (!baseURL || !apiKey) throw new Error("Hermes monitor API is not configured.");
    if (action === "list") {
      await this.opts.hermesJobsBridge?.refresh();
      return { monitors: (await this.opts.monitorSource.list()).map(toWireMonitor) };
    }
    if (action === "get") {
      const monitor = (await this.opts.monitorSource.list()).find((item) => item.id === monitor_id);
      if (!monitor) throw new Error(`Monitor not found: ${monitor_id ?? "<missing>"}`);
      return { monitor: toWireMonitor(monitor) };
    }
    if (action === "list_runs") {
      if (!monitor_id) throw new Error("Run history requires monitor_id.");
      return { runs: (await listJobRuns(monitor_id)) as unknown as Array<Record<string, unknown>> };
    }
    if (action === "read_run") {
      if (!monitor_id || !run_id) throw new Error("Reading a run requires monitor_id and run_id.");
      const content = await readJobRunOutput(monitor_id, run_id);
      return { content: content ? summarizeOutput(content) : "" };
    }

    const methodByAction: Record<string, string> = {
      create: "POST",
      update: "PATCH",
      delete: "DELETE",
      pause: "POST",
      resume: "POST",
      run_now: "POST",
    };
    const method = methodByAction[action];
    if (!method) throw new Error(`Unsupported Hermes monitor action: ${action}`);
    const url =
      action === "create"
        ? `${baseURL.replace(/\/$/, "")}/api/jobs`
        : `${baseURL.replace(/\/$/, "")}/api/jobs/${encodeURIComponent(monitor_id ?? "")}${action === "pause" ? "/pause" : action === "resume" ? "/resume" : action === "run_now" ? "/run" : ""}`;
    if (action !== "create" && !monitor_id) throw new Error(`${action} requires monitor_id.`);

    const response = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: method === "DELETE" ? undefined : JSON.stringify(input ?? {}),
    });
    if (!response.ok) {
      throw new Error(`Hermes ${action} failed: HTTP ${response.status}`);
    }
    await this.opts.hermesJobsBridge?.refresh();
    return { monitors: (await this.opts.monitorSource.list()).map(toWireMonitor) };
  }

  private async runHarnessTurn(
    harness: OrchestratorHarness,
    correlation_id: string,
    target: string,
    prompt: string,
  ): Promise<void> {
    const turn = this.registry.register(correlation_id);
    this.activeByTarget.set(target, correlation_id);
    this.emitHarnessState();
    this.emitHarnessSnapshot();
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
      // Only clear if we're still the active turn for this target —
      // submit_with_steer may have already replaced us.
      if (this.activeByTarget.get(target) === correlation_id) {
        this.activeByTarget.delete(target);
      }
      this.emitHarnessState();
      this.emitHarnessSnapshot();
    }
  }

  private sendEvent(event: HarnessEvent): void {
    // Catch-all log first — this captures even events that fail to send
    // (socket closed, etc.) which are exactly the ones we want to inspect.
    const provider =
      (event as { provider?: string }).provider ??
      (event as { target?: string }).target ??
      "unknown";
    this.getCatchAllLogger(provider)(event);

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

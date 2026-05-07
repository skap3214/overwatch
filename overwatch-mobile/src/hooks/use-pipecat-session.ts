/**
 * use-pipecat-session — single hook over PipecatClient + RNDailyTransport.
 *
 * Replaces the legacy hook salad (use-audio-player, use-audio-recorder,
 * use-overwatch-turn, use-realtime-connection). Subscribes to RTVI events,
 * drives the conversation store.
 *
 * Mitigates pipecat#4086 (RN client-ready handshake sometimes never fires)
 * with a 5s retry/timeout on the bot-ready handshake.
 */

import { useEffect, useRef, useState, useCallback } from "react";
// @ts-ignore — deps declared in package.json; type definitions resolve after `npm install`.
import { PipecatClient } from "@pipecat-ai/client-js";
// @ts-ignore — same as above.
import { RNDailyTransport } from "@pipecat-ai/react-native-daily-transport";

import { useConversationStore } from "../stores/conversation";
import { useHarnessStore } from "../stores/harness-store";
import { useMonitorsStore } from "../stores/monitors-store";
import { useSkillsStore } from "../stores/skills-store";
import { useNotificationsStore } from "../stores/notifications-store";
import {
  handleMonitorActionResult,
  registerMonitorActionSender,
} from "../services/monitors-api";
import type {
  AgentProviderInfo,
  HarnessCapabilities,
  MonitorActionMetadata,
  ScheduledMonitor,
} from "../types";

const READY_TIMEOUT_MS = 5000;

interface SessionOptions {
  /** Daily room URL minted by the relay's /api/sessions/start. */
  roomUrl: string;
  /** Daily meeting token (also from the relay). */
  roomToken: string;
  /** Per-session HMAC the phone derived; the orchestrator already received
   *  it via runner_args.body, this is just kept here for parity / future. */
  sessionToken: string;
  /** Either "ptt" or "always-listening". */
  mode: "ptt" | "always";
}

export type SessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "disconnected";

export function usePipecatSession() {
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<PipecatClient | null>(null);
  const remoteAudioSuppressedRef = useRef(false);
  const botTextAfterSuppressionRef = useRef(false);

  const setTransportState = useConversationStore((s) => s.setTransportState);
  const appendUserMessage = useConversationStore((s) => s.appendUserMessage);
  const appendBotText = useConversationStore((s) => s.appendBotText);
  const appendBotReasoning = useConversationStore((s) => s.appendBotReasoning);
  const scheduleFinalize = useConversationStore((s) => s.scheduleAssistantFinalize);
  const cancelFinalize = useConversationStore((s) => s.cancelAssistantFinalize);
  const setRemoteMuted = useConversationStore((s) => s.setRemoteMuted);
  const appendToolCall = useConversationStore((s) => s.appendToolCall);
  const appendError = useConversationStore((s) => s.appendError);

  const connect = useCallback(
    async (opts: SessionOptions) => {
      if (clientRef.current) {
        logMobile("connect.skipped_existing_client");
        return;
      }

      logMobile("connect.start", {
        mode: opts.mode,
        roomUrlHost: safeUrlHost(opts.roomUrl),
        hasRoomToken: Boolean(opts.roomToken),
        hasSessionToken: Boolean(opts.sessionToken),
      });
      setStatus("connecting");
      setTransportState("connecting");
      setError(null);

      const client = new PipecatClient({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transport: new RNDailyTransport() as any,
        // Always start the mic on; Daily's call machine throws
        // "Cannot read property 'getVideoTracks' of undefined" when both
        // mic and cam are off at connect (it assumes at least one local
        // track to enumerate). For PTT mode we *release* the track right
        // after connect — see releaseMicTrack() — so iOS stops showing the
        // orange "recording" indicator and AirPods routing stays correct.
        enableMic: true,
        enableCam: false,
        callbacks: {
          onConnected: () => {
            logMobile("rtvi.connected", { mode: opts.mode });
            setStatus("connected");
            setTransportState("connected");
            // PTT: discard the mic track right away. enableMic(false) only
            // mutes the track and leaves it allocated, which keeps the iOS
            // recording indicator on and forces audio routing into the
            // built-in speaker even when AirPods are connected.
            if (opts.mode === "ptt") {
              void releaseMicTrack(client);
            }
          },
          onDisconnected: () => {
            logMobile("rtvi.disconnected");
            setStatus("disconnected");
            setTransportState("disconnected");
          },
          onUserStartedSpeaking: () => {
            logMobile("rtvi.user_started_speaking");
            remoteAudioSuppressedRef.current = true;
            botTextAfterSuppressionRef.current = false;
            void sendInterruptIntentForClient(client, "user_started_speaking");
          },
          onUserStoppedSpeaking: () => {
            logMobile("rtvi.user_stopped_speaking");
          },
          onUserTranscript: (data: { text: string; final?: boolean }) => {
            logMobile("rtvi.user_transcript", {
              final: Boolean(data.final),
              len: data.text.length,
            });
            if (data.text.trim()) {
              remoteAudioSuppressedRef.current = true;
              botTextAfterSuppressionRef.current = false;
              void hardStopRemoteAudioPlayback(
                client,
                `user_transcript_${data.final ? "final" : "interim"}`,
              );
            }
            appendUserMessage(data.text, Boolean(data.final));
          },
          onBotLlmText: (data: { text: string }) => {
            logMobile("rtvi.bot_llm_text", { len: data.text.length });
            if (remoteAudioSuppressedRef.current && data.text.length > 0) {
              botTextAfterSuppressionRef.current = true;
              logMobile("remote_audio_restore.armed_by_new_bot_text");
            }
            cancelFinalize();
            appendBotText(data.text);
          },
          onBotLlmReasoning: (data: { text: string }) => {
            logMobile("rtvi.bot_llm_reasoning", { len: data.text.length });
            appendBotReasoning(data.text);
          },
          onBotTtsStarted: () => {
            logMobile("rtvi.bot_tts_started", {
              remoteAudioSuppressed: remoteAudioSuppressedRef.current,
              botTextAfterSuppression: botTextAfterSuppressionRef.current,
            });
            if (
              !remoteAudioSuppressedRef.current ||
              botTextAfterSuppressionRef.current
            ) {
              restoreRemoteAudioPlayback(client, "bot_tts_started");
              remoteAudioSuppressedRef.current = false;
              botTextAfterSuppressionRef.current = false;
            } else {
              logMobile("remote_audio_restore.skipped_stale_tts_started");
            }
            cancelFinalize();
          },
          onBotTtsStopped: () => {
            logMobile("rtvi.bot_tts_stopped");
            scheduleFinalize();
          },
          onUserMutedStateChanged: (muted: boolean) => {
            logMobile("rtvi.user_muted_state_changed", { muted });
            setRemoteMuted(muted);
          },
          onMessageError: (msg: unknown) => {
            logMobile("rtvi.message_error", { error: stringifyError(msg) });
            setError(typeof msg === "string" ? msg : JSON.stringify(msg));
          },
          onError: (err: unknown) => {
            logMobile("rtvi.error", { error: stringifyError(err) });
            setError(typeof err === "string" ? err : JSON.stringify(err));
            setStatus("error");
          },
          onServerMessage: (data: unknown) => {
            logMobile("rtvi.server_message", summarizeServerMessage(data));
            handleServerMessage(data, {
              appendToolCall,
              appendError,
              appendBotReasoning,
              scheduleAssistantFinalize: scheduleFinalize,
            });
          },
        } as Record<string, unknown>,
      });

      clientRef.current = client;
      registerMonitorActionSender((payload) => {
        client.sendClientMessage("monitor_action", payload);
      });

      try {
        // Pass already-resolved transport params, NOT an APIRequest-shaped
        // {endpoint, requestData} (that path POSTs to `endpoint` and treats
        // the response as connection params; we already POSTed to the
        // relay ourselves so we have the room url/token in hand).
        // RNDailyTransport's _validateConnectionParams accepts {url, token}.
        await Promise.race([
          client.connect({ url: opts.roomUrl, token: opts.roomToken }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("client-ready handshake timed out")),
              READY_TIMEOUT_MS,
            ),
          ),
        ]);
        logMobile("connect.done");
      } catch (err) {
        logMobile("connect.failed", { error: stringifyError(err) });
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
        await disconnect();
        // Re-throw so the caller (app/index.tsx auto-connect) can populate
        // its own connectError and surface a Retry UI. Swallowing here was
        // the bug — the local hook state never propagated up.
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    [
      appendBotText,
      appendBotReasoning,
      appendError,
      appendToolCall,
      appendUserMessage,
      cancelFinalize,
      scheduleFinalize,
      setRemoteMuted,
      setTransportState,
    ],
  );

  const disconnect = useCallback(async () => {
    const client = clientRef.current;
    if (!client) {
      logMobile("disconnect.skipped_no_client");
      return;
    }
    logMobile("disconnect.start");
    try {
      await client.disconnect();
      logMobile("disconnect.done");
    } catch (err) {
      logMobile("disconnect.failed", { error: stringifyError(err) });
    } finally {
      clientRef.current = null;
      registerMonitorActionSender(null);
      setStatus("disconnected");
      setTransportState("disconnected");
    }
  }, [setTransportState]);

  /** Send a user-typed message (typed input path; bypasses VAD). */
  const sendUserText = useCallback(async (text: string) => {
    const client = clientRef.current;
    if (!client) {
      logMobile("send_user_text.skipped_no_client", { len: text.length });
      return;
    }
    logMobile("send_user_text.start", { len: text.length });
    try {
      client.sendClientMessage("user_text", { text });
      logMobile("send_user_text.sent", { len: text.length });
    } catch (err) {
      logMobile("send_user_text.failed", { error: stringifyError(err) });
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /** Push to talk: open the mic for the duration of a press.
   *  When disabling, fully release the underlying Daily mic track instead
   *  of just muting — keeps the iOS recording indicator off and lets
   *  audio route through AirPods normally between presses. */
  const setMicEnabled = useCallback(async (enabled: boolean) => {
    const client = clientRef.current;
    if (!client) {
      logMobile("set_mic_enabled.skipped_no_client", { enabled });
      return;
    }
    logMobile("set_mic_enabled.start", { enabled });
    try {
      if (enabled) {
        client.enableMic(true);
      } else {
        await releaseMicTrack(client);
      }
      logMobile("set_mic_enabled.done", { enabled });
    } catch (err) {
      logMobile("set_mic_enabled.failed", {
        enabled,
        error: stringifyError(err),
      });
    }
  }, []);

  /** Hint the orchestrator that the user is interrupting. Server is authoritative. */
  const sendInterruptIntent = useCallback(async () => {
    const client = clientRef.current;
    if (!client) {
      logMobile("interrupt_intent.skipped_no_client");
      return;
    }
    remoteAudioSuppressedRef.current = true;
    botTextAfterSuppressionRef.current = false;
    await sendInterruptIntentForClient(client, "explicit_interrupt_intent");
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      void disconnect();
    };
  }, [disconnect]);

  return {
    status,
    error,
    connect,
    disconnect,
    sendUserText,
    setMicEnabled,
    sendInterruptIntent,
  };
}

/**
 * Release the local mic track on the underlying Daily call object so iOS
 * stops showing the orange recording indicator and audio routing returns
 * to AirPods between push-to-talk presses.
 *
 * Pipecat's `enableMic(false)` only mutes (the track stays allocated).
 * Daily's `setLocalAudio(false, { forceDiscardTrack: true })` is the
 * documented escape hatch — but it's not exposed via PipecatClient or
 * RNDailyTransport's public surface, so we reach into the transport's
 * `dailyCallClient` proxy. Best-effort: if the API shape changes upstream
 * we silently fall back to a regular mute.
 */
async function releaseMicTrack(client: PipecatClient): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport: any = (client as any).transport ?? (client as any)._transport;
    const daily = transport?.dailyCallClient ?? transport?._daily;
    if (daily?.setLocalAudio) {
      logMobile("daily.set_local_audio.force_discard.start");
      await daily.setLocalAudio(false, { forceDiscardTrack: true });
      logMobile("daily.set_local_audio.force_discard.done");
      return;
    }
  } catch (err) {
    logMobile("daily.set_local_audio.force_discard.failed", {
      error: stringifyError(err),
    });
    // fall through to mute
  }
  try {
    logMobile("client.enable_mic.false_fallback.start");
    client.enableMic(false);
    logMobile("client.enable_mic.false_fallback.done");
  } catch (err) {
    logMobile("client.enable_mic.false_fallback.failed", {
      error: stringifyError(err),
    });
  }
}

async function sendInterruptIntentForClient(
  client: PipecatClient,
  reason: string,
): Promise<void> {
  logMobile("interrupt_intent.start", { reason });
  try {
    client.sendClientMessage("interrupt_intent", { reason });
    logMobile("interrupt_intent.sent", { reason });
  } catch (err) {
    logMobile("interrupt_intent.send_failed", {
      reason,
      error: stringifyError(err),
    });
  }
  await hardStopRemoteAudioPlayback(client, reason);
  logMobile("interrupt_intent.local_audio_stop_done", { reason });
}

async function hardStopRemoteAudioPlayback(
  client: PipecatClient,
  reason: string,
): Promise<void> {
  const daily = getDailyCallClient(client);
  if (!daily) {
    logMobile("remote_audio_stop.no_daily_client", { reason });
    return;
  }

  const participants = getRemoteParticipants(daily);
  if (participants.length === 0) {
    logMobile("remote_audio_stop.no_remote_participants", { reason });
    return;
  }

  logMobile("remote_audio_stop.start", {
    reason,
    remoteCount: participants.length,
    remoteIds: participants.map((p) => p.sessionId),
  });

  for (const participant of participants) {
    if (participant.audioTrack && "enabled" in participant.audioTrack) {
      participant.audioTrack.enabled = false;
    }
  }

  logMobile("remote_audio_stop.muted_tracks", {
    reason,
    remoteCount: participants.length,
  });
}

function restoreRemoteAudioPlayback(client: PipecatClient, reason: string): void {
  const daily = getDailyCallClient(client);
  if (!daily) {
    logMobile("remote_audio_restore.no_daily_client", { reason });
    return;
  }

  const latestParticipants = getRemoteParticipants(daily);
  for (const participant of latestParticipants) {
    if (participant.audioTrack && "enabled" in participant.audioTrack) {
      participant.audioTrack.enabled = true;
    }
  }
  logMobile("remote_audio_restore.done", {
    reason,
    remoteCount: latestParticipants.length,
  });
}

function getDailyCallClient(client: PipecatClient): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport: any = (client as any).transport ?? (client as any)._transport;
    return transport?.dailyCallClient ?? transport?._daily ?? null;
  } catch {
    return null;
  }
}

function getRemoteParticipants(
  daily: any,
): Array<{ sessionId: string; audioTrack?: { enabled: boolean } }> {
  const rawParticipants = daily?.participants?.();
  if (!rawParticipants || typeof rawParticipants !== "object") return [];
  return Object.values(rawParticipants)
    .filter((participant: any) => participant && participant.local === false)
    .map((participant: any) => ({
      sessionId: String(participant.session_id ?? ""),
      audioTrack:
        participant.tracks?.audio?.persistentTrack ??
        participant.tracks?.audio?.track ??
        participant.audioTrack,
    }))
    .filter((participant) => participant.sessionId.length > 0);
}

function logMobile(event: string, payload?: Record<string, unknown>): void {
  const entry = {
    at: new Date().toISOString(),
    event,
    ...(payload ?? {}),
  };
  console.info("[overwatch-mobile]", JSON.stringify(entry));
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function safeUrlHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "invalid";
  }
}

function summarizeServerMessage(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return { valueType: typeof data };
  const msg = data as {
    type?: string;
    event?: { type?: string; phase?: string; name?: string };
  };
  return {
    type: msg.type,
    eventType: msg.event?.type,
    eventPhase: msg.event?.phase,
    eventName: msg.event?.name,
  };
}

interface ServerMessageHandlers {
  appendToolCall: (name: string, phase?: "start" | "complete") => void;
  appendError: (text: string) => void;
  appendBotReasoning: (text: string) => void;
  scheduleAssistantFinalize: () => void;
}

function handleServerMessage(
  msg: unknown,
  handlers: ServerMessageHandlers,
): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as {
    type?: string;
    active_provider_id?: string;
    active_target?: string;
    capabilities?: HarnessCapabilities;
    providers?: AgentProviderInfo[];
    monitors?: ScheduledMonitor[];
    actions?: MonitorActionMetadata;
    provider_id?: string;
    skills?: unknown[];
    id?: string;
    title?: string;
    body?: string;
    kind?: string;
    created_at?: string;
    speakable_text?: string;
    status?: string;
    source?: { type?: string; id?: string };
    metadata?: Record<string, unknown>;
    event?: {
      type?: string;
      phase?: string;
      name?: string;
      message?: string;
      text?: string;
      provider?: string;
      kind?: string;
      notification?: unknown;
    };
  };
  switch (m.type) {
    case "harness_snapshot":
      if (m.active_provider_id && m.capabilities) {
        useHarnessStore
          .getState()
          .setSnapshot(m.active_provider_id, m.capabilities, m.providers);
      }
      return;
    case "monitor_snapshot":
      useMonitorsStore.getState().replaceMonitors(m.monitors ?? [], m.actions);
      return;
    case "skills_snapshot":
      useSkillsStore.getState().replaceSkills(
        Array.isArray(m.skills) ? (m.skills as never[]) : [],
      );
      return;
    case "notification":
      if (m.id && m.title && m.body && m.kind && m.created_at && m.status) {
        useNotificationsStore.getState().upsertNotification({
          id: m.id,
          title: m.title,
          body: m.body,
          kind: m.kind as never,
          createdAt: m.created_at,
          speakableText: m.speakable_text,
          status: m.status as never,
          source:
            m.source?.type === "scheduler" ||
            m.source?.type === "agent" ||
            m.source?.type === "system"
              ? (m.source as never)
              : { type: "system" },
          metadata: m.metadata,
        });
      }
      return;
    case "monitor_action_result":
      handleMonitorActionResult(m as never);
      return;
    case "harness_event":
      break;
    default:
      return;
  }
  if (!m.event) return;
  const ev = m.event;

  // Streaming text (`text_delta`, `assistant_message`) arrives via RTVI's
  // `onBotLlmText` → `appendBotText` path; we deliberately don't forward
  // those events as server-messages on the orchestrator side. Anything
  // RTVI doesn't auto-relay (tool calls, errors, session_end markers)
  // shows up here.
  if (ev.type === "tool_lifecycle" && ev.name) {
    handlers.appendToolCall(
      ev.name,
      ev.phase === "complete" ? "complete" : "start",
    );
    return;
  }

  if (ev.type === "session_end") {
    handlers.scheduleAssistantFinalize();
    return;
  }

  if (ev.type === "error" && ev.message) {
    handlers.appendError(ev.message);
    return;
  }

  if (ev.type === "reasoning_delta" && ev.text) {
    handlers.appendBotReasoning(ev.text);
    return;
  }

  if (
    ev.provider === "overwatch" &&
    ev.kind === "notification" &&
    ev.notification &&
    typeof ev.notification === "object"
  ) {
    const notification = ev.notification as {
      id?: string;
      title?: string;
      body?: string;
      kind?: string;
      createdAt?: string;
      created_at?: string;
      speakableText?: string;
      speakable_text?: string;
      status?: string;
      source?: { type?: string; id?: string };
      metadata?: Record<string, unknown>;
    };
    if (
      notification.id &&
      notification.title &&
      notification.body &&
      notification.kind &&
      notification.status
    ) {
      useNotificationsStore.getState().upsertNotification({
        id: notification.id,
        title: notification.title,
        body: notification.body,
        kind: notification.kind as never,
        createdAt:
          notification.createdAt ??
          notification.created_at ??
          new Date().toISOString(),
        speakableText:
          notification.speakableText ?? notification.speakable_text,
        status: notification.status as never,
        source:
          notification.source?.type === "scheduler" ||
          notification.source?.type === "agent" ||
          notification.source?.type === "system"
            ? (notification.source as never)
            : { type: "system" },
        metadata: notification.metadata,
      });
    }
  }
}

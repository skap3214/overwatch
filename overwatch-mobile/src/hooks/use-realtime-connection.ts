import { useEffect } from "react";
import { realtimeClient } from "../services/realtime";
import { useConnectionStore } from "../stores/connection-store";
import { useTurnStore } from "../stores/turn-store";
import { useNotificationsStore } from "../stores/notifications-store";
import { useMonitorsStore } from "../stores/monitors-store";
import { useSkillsStore } from "../stores/skills-store";
import { useHarnessStore } from "../stores/harness-store";
import { useAudioPlayer } from "./use-audio-player";
import { useThemeStore } from "../stores/theme-store";
import type {
  ActiveSkill,
  AgentProviderInfo,
  HarnessCapabilities,
  NotificationEvent,
  ScheduledMonitor,
  WsEnvelope,
} from "../types";

// Shared ref so other hooks can reset audio state on cancel/interrupt
export const audioActiveRef = { current: false };

// Generation counter — incremented on every cancel or new turn initiation.
// Events from a stale generation are silently dropped.
export let turnGeneration = 0;
export function bumpGeneration(): number {
  return ++turnGeneration;
}

export function useRealtimeConnection() {
  const backendURL = useConnectionStore((s) => s.backendURL);
  const setConnectionStatus = useConnectionStore((s) => s.setConnectionStatus);
  const player = useAudioPlayer();

  useEffect(() => {
    // The generation that the current foreground turn was started under.
    // Set when turn.started arrives; all subsequent events for that turn
    // are dropped if turnGeneration has moved past this value.
    let fgGen = turnGeneration;

    const isFgStale = () => fgGen !== turnGeneration;

    // Background turns are never dropped.  They are serialized by the
    // coordinator on the backend (one at a time, WebSocket messages in
    // order), so there is no risk of interleaving or stale events.
    // Previous approaches (bgGen counter, turn-ID matching) caused
    // events to be silently lost when the useEffect closure re-ran or
    // when the user interacted during a background turn.

    realtimeClient.setHandlers({
      onStatus: (status) => {
        setConnectionStatus(status);
        if (status === "connected") {
          realtimeClient.updateSettings({ tts: useThemeStore.getState().ttsEnabled });
        }
      },
      onEnvelope: (envelope: WsEnvelope) => {
        switch (envelope.type) {
          // ── Notifications (never stale) ──────────────────────────
          case "notification.snapshot": {
            const notifications = (
              envelope.payload as { notifications: NotificationEvent[] }
            ).notifications;
            notifications.forEach((notification) =>
              useNotificationsStore.getState().upsertNotification(notification)
            );
            break;
          }
          case "notification.created":
          case "notification.updated": {
            const notification = envelope.payload as NotificationEvent;
            useNotificationsStore.getState().upsertNotification(notification);
            break;
          }
          case "monitor.snapshot":
          case "monitor.updated": {
            const monitors = (
              envelope.payload as { monitors: ScheduledMonitor[] }
            ).monitors;
            useMonitorsStore.getState().replaceMonitors(monitors);
            break;
          }
          case "skill.snapshot":
          case "skill.updated": {
            const skills = (envelope.payload as { skills: ActiveSkill[] }).skills;
            useSkillsStore.getState().replaceSkills(skills);
            break;
          }
          case "harness.snapshot": {
            const payload = envelope.payload as {
              active?: string;
              provider?: string;
              capabilities: HarnessCapabilities;
              providers?: AgentProviderInfo[];
            };
            const active = payload.active ?? payload.provider ?? "pi-coding-agent";
            useHarnessStore
              .getState()
              .setSnapshot(active, payload.capabilities, payload.providers);
            break;
          }

          // ── Foreground turn events ───────────────────────────────
          case "turn.started":
            // Lock this turn to the current generation
            fgGen = turnGeneration;
            audioActiveRef.current = false;
            // Flush stale pending message (same reason as background.turn_started)
            useTurnStore.setState({ pendingMessageId: null, pendingText: "" });
            useTurnStore.getState().setTurnState("processing");
            break;
          case "turn.text_delta":
            if (isFgStale()) break;
            useTurnStore.getState().handleTextDelta(
              (envelope.payload as { text: string }).text
            );
            break;
          case "turn.reasoning_delta":
            if (isFgStale()) break;
            useTurnStore.getState().handleReasoningDelta(
              (envelope.payload as { text: string }).text
            );
            break;
          case "turn.assistant_message":
            break;
          case "turn.tool_call":
            if (isFgStale()) break;
            useTurnStore.getState().handleToolCall(
              (envelope.payload as { name: string }).name
            );
            break;
          case "turn.audio_chunk": {
            if (isFgStale()) break;
            const currentState = useTurnStore.getState().turnState;
            if (currentState === "recording" || currentState === "preparing") break;
            if (!audioActiveRef.current) {
              player.startSession();
              useTurnStore.getState().setTurnState("playing");
              audioActiveRef.current = true;
            }
            player.feedChunk(
              (envelope.payload as { base64: string }).base64
            );
            break;
          }
          case "turn.tts_error":
            break;
          case "turn.error":
            if (isFgStale()) break;
            useTurnStore.getState().handleError(
              (envelope.payload as { message: string }).message
            );
            player.stopAndReset();
            audioActiveRef.current = false;
            break;
          case "turn.done":
            if (isFgStale()) break;
            if (audioActiveRef.current) {
              player.markEnd();
            }
            audioActiveRef.current = false;
            useTurnStore.getState().handleDone();
            break;

          // ── Relay mode: voice transcript from CLI bridge ─────────
          case "voice.transcript": {
            if (isFgStale()) break;
            const text = (envelope.payload as { text: string }).text;
            useTurnStore.getState().addUserMessage(text);
            const tts = useThemeStore.getState().ttsEnabled;
            realtimeClient.startTextTurn(text, { tts });
            break;
          }
          case "voice.error": {
            if (isFgStale()) break;
            useTurnStore.getState().handleError(
              (envelope.payload as { message: string }).message
            );
            break;
          }

          // ── Background turn events ──────────────────────────────
          // Always processed — never dropped.  See comment above.
          case "background.turn_started":
            audioActiveRef.current = false;
            // Flush any stale pending assistant message from a previous turn
            // whose handleDone was dropped (e.g. by the old bgGen gate).
            // Without this, handleTextDelta appends to a ghost message ID
            // and the new turn's response is silently lost.
            useTurnStore.setState({ pendingMessageId: null, pendingText: "" });
            useTurnStore
              .getState()
              .addUserMessage(
                `[Scheduled] ${
                  (envelope.payload as { summary?: string; prompt?: string }).summary ||
                  (envelope.payload as { prompt?: string }).prompt ||
                  "Background check"
                }`
              );
            useTurnStore.getState().setTurnState("processing");
            break;
          case "background.turn_text_delta":
            useTurnStore.getState().handleTextDelta(
              (envelope.payload as { text: string }).text
            );
            break;
          case "background.turn_reasoning_delta":
            useTurnStore.getState().handleReasoningDelta(
              (envelope.payload as { text: string }).text
            );
            break;
          case "background.turn_tool_call":
            useTurnStore.getState().handleToolCall(
              (envelope.payload as { name: string }).name
            );
            break;
          case "background.turn_audio_chunk": {
            const bgState = useTurnStore.getState().turnState;
            if (bgState === "recording" || bgState === "preparing") break;
            if (!audioActiveRef.current) {
              player.startSession();
              useTurnStore.getState().setTurnState("playing");
              audioActiveRef.current = true;
            }
            player.feedChunk(
              (envelope.payload as { base64: string }).base64
            );
            break;
          }
          case "background.turn_tts_error":
            break;
          case "background.turn_error":
            useTurnStore.getState().handleError(
              (envelope.payload as { message: string }).message
            );
            player.stopAndReset();
            audioActiveRef.current = false;
            break;
          case "background.turn_done":
            if (audioActiveRef.current) {
              player.markEnd();
            }
            audioActiveRef.current = false;
            useTurnStore.getState().handleDone();
            break;
          default:
            break;
        }
      },
    });
  }, [setConnectionStatus, player]);

  useEffect(() => {
    if (!backendURL) {
      realtimeClient.disconnect();
      return;
    }
    // Relay mode — QR scan already called connectViaRelay, don't interfere
    if (backendURL.startsWith("relay:") || backendURL.includes("(relay:")) {
      // No cleanup — don't disconnect a relay connection on re-render
      return;
    }
    realtimeClient.connect(backendURL);
    return () => {
      // Only disconnect if we're the ones who connected (direct mode)
      if (realtimeClient.mode === "direct") {
        realtimeClient.disconnect();
      }
    };
  }, [backendURL]);
}

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

const READY_TIMEOUT_MS = 5000;

interface SessionOptions {
  endpoint: string;
  /** Per-session token signed by the phone for the orchestrator's use. */
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
      if (clientRef.current) return;

      setStatus("connecting");
      setTransportState("connecting");
      setError(null);

      const client = new PipecatClient({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transport: new RNDailyTransport() as any,
        enableMic: opts.mode === "always",
        enableCam: false,
        callbacks: {
          onConnected: () => {
            setStatus("connected");
            setTransportState("connected");
          },
          onDisconnected: () => {
            setStatus("disconnected");
            setTransportState("disconnected");
          },
          onUserTranscript: (data: { text: string; final?: boolean }) => {
            appendUserMessage(data.text, Boolean(data.final));
          },
          onBotLlmText: (data: { text: string }) => {
            cancelFinalize();
            appendBotText(data.text);
          },
          onBotLlmReasoning: (data: { text: string }) => {
            appendBotReasoning(data.text);
          },
          onBotTtsStarted: () => {
            cancelFinalize();
          },
          onBotTtsStopped: () => {
            scheduleFinalize();
          },
          onUserMutedStateChanged: (muted: boolean) => {
            setRemoteMuted(muted);
          },
          onMessageError: (msg: unknown) => {
            setError(typeof msg === "string" ? msg : JSON.stringify(msg));
          },
          onError: (err: unknown) => {
            setError(typeof err === "string" ? err : JSON.stringify(err));
            setStatus("error");
          },
          onServerMessage: (data: unknown) => {
            handleServerMessage(data, {
              appendToolCall,
              appendError,
            });
          },
        } as Record<string, unknown>,
      });

      clientRef.current = client;

      try {
        await Promise.race([
          client.connect({
            endpoint: opts.endpoint,
            requestData: { session_token: opts.sessionToken, mode: opts.mode },
          }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("client-ready handshake timed out")),
              READY_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
        await disconnect();
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
    if (!client) return;
    try {
      await client.disconnect();
    } catch {
      // ignore — disconnection is best-effort
    } finally {
      clientRef.current = null;
      setStatus("disconnected");
      setTransportState("disconnected");
    }
  }, [setTransportState]);

  /** Send a user-typed message (typed input path; bypasses VAD). */
  const sendUserText = useCallback(async (text: string) => {
    const client = clientRef.current;
    if (!client) return;
    try {
      client.sendClientMessage("user_text", { text });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /** Push to talk: open the mic for the duration of a press. */
  const setMicEnabled = useCallback(async (enabled: boolean) => {
    const client = clientRef.current;
    if (!client) return;
    try {
      client.enableMic(enabled);
    } catch {
      // ignore
    }
  }, []);

  /** Hint the orchestrator that the user is interrupting. Server is authoritative. */
  const sendInterruptIntent = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      client.sendClientMessage("interrupt_intent", {});
    } catch {
      // ignore
    }
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

interface ServerMessageHandlers {
  appendToolCall: (name: string, phase?: "start" | "complete") => void;
  appendError: (text: string) => void;
}

function handleServerMessage(
  msg: unknown,
  handlers: ServerMessageHandlers,
): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as {
    type?: string;
    event?: {
      type?: string;
      phase?: string;
      name?: string;
      message?: string;
    };
  };
  if (m.type !== "harness_event" || !m.event) return;
  const ev = m.event;
  if (ev.type === "tool_lifecycle" && ev.name) {
    handlers.appendToolCall(
      ev.name,
      ev.phase === "complete" ? "complete" : "start",
    );
  } else if (ev.type === "error" && ev.message) {
    handlers.appendError(ev.message);
  }
}

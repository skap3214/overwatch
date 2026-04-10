export type TurnState = "idle" | "recording" | "processing" | "playing";

export type ConnectionStatus = "disconnected" | "connected" | "error";

export type MessageRole = "user" | "assistant" | "tool_call" | "error";

export type Message = {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: number;
};

export type SSEEvent =
  | { type: "text_delta"; data: { text: string } }
  | { type: "tool_call"; data: { name: string } }
  | {
      type: "audio_chunk";
      data: { base64: string; mimeType: string };
    }
  | { type: "tts_error"; data: { message: string } }
  | { type: "error"; data: { message: string } }
  | { type: "done"; data: Record<string, never> };

export type NotificationStatus = "new" | "seen" | "acknowledged";

export type NotificationKind =
  | "scheduled_task_status"
  | "scheduled_task_result"
  | "scheduled_task_error"
  | "delegated_session_update"
  | "system_notice";

export type NotificationEvent = {
  id: string;
  createdAt: string;
  kind: NotificationKind;
  title: string;
  body: string;
  speakableText?: string;
  status: NotificationStatus;
  source: {
    type: "scheduler" | "agent" | "system";
    id?: string;
  };
  metadata?: Record<string, unknown>;
};

export type WsEnvelope<T = unknown> = {
  id: string;
  createdAt: string;
  type: string;
  payload: T;
};

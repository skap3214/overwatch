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
  | { type: "transcript"; data: { text: string } }
  | { type: "text_delta"; data: { text: string } }
  | { type: "tool_call"; data: { name: string } }
  | {
      type: "audio_chunk";
      data: { base64: string; mimeType: string };
    }
  | { type: "tts_error"; data: { message: string } }
  | { type: "error"; data: { message: string } }
  | { type: "done"; data: Record<string, never> };

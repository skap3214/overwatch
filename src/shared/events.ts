export type HarnessEvent =
  | { type: "session_init"; sessionId?: string; tools?: string[]; raw: unknown }
  | { type: "text_delta"; text: string; raw: unknown }
  | { type: "assistant_message"; text: string; raw: unknown }
  | { type: "tool_call"; name: string; raw: unknown }
  | { type: "result"; text: string; raw: unknown }
  | { type: "error"; message: string; raw: unknown };

export type TtsEvent =
  | { type: "audio_chunk"; mimeType: string; data: Uint8Array }
  | { type: "marker"; name: string }
  | { type: "error"; message: string };

export interface SttResult {
  transcript: string;
  raw: unknown;
}

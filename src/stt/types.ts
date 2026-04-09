import type { SttResult } from "../shared/events.js";

export interface SttRequest {
  audio: Uint8Array;
  mimeType: string;
  language?: string;
  abortSignal?: AbortSignal;
}

export interface SttAdapter {
  transcribe(request: SttRequest): Promise<SttResult>;
}

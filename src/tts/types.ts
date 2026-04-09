import type { TtsEvent } from "../shared/events.js";

export interface TtsSynthesisRequest {
  textChunks: AsyncIterable<string>;
  abortSignal?: AbortSignal;
}

export interface TtsAdapter {
  synthesize(request: TtsSynthesisRequest): AsyncIterable<TtsEvent>;
}

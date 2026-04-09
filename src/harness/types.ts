import type { HarnessEvent } from "../shared/events.js";

export interface HarnessTurnRequest {
  prompt: string;
  cwd?: string;
  abortSignal?: AbortSignal;
}

export interface OrchestratorHarness {
  runTurn(request: HarnessTurnRequest): AsyncIterable<HarnessEvent>;
}

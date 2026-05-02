import type { AdapterEvent, AdapterCapabilities } from "../shared/events.js";

export interface HarnessTurnRequest {
  prompt: string;
  cwd?: string;
  /** Correlation ID for this turn. Adapters echo this back when they cannot map an event. */
  correlation_id: string;
  /** Cancellation signal. Adapters MUST emit a `cancel_confirmed` event before resolving. */
  abortSignal?: AbortSignal;
}

export interface OrchestratorHarness {
  readonly capabilities: AdapterCapabilities;
  /** Stable provider name for use in the registry's "<provider>/<kind>" lookups. */
  readonly provider: string;
  runTurn(request: HarnessTurnRequest): AsyncIterable<AdapterEvent>;
}

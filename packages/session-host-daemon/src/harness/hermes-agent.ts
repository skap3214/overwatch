/**
 * Hermes Agent harness — routes turns to a locally-running Hermes gateway
 * via its OpenAI-compatible HTTP API server.
 *
 * Wire protocol:
 *   1. POST /v1/runs    → returns { run_id } in HTTP 202
 *   2. GET /v1/runs/{run_id}/events  → SSE stream until run.completed/failed
 *   3. POST /v1/runs/{run_id}/cancel  → cancel an in-flight run (used on abort)
 *
 * Voice turns are wrapped as <voice>...</voice> per the user's SOUL.md
 * convention. The first turn of each session prepends a synthetic skill
 * activation message that points at ~/.hermes/skills/<skillName>/.
 */

import type { AdapterEvent, AdapterCapabilities } from "../shared/events.js";
import type { HarnessTurnRequest, OrchestratorHarness } from "./types.js";
import { wrapVoiceTurn, prependSkillActivation } from "./hermes-prompt.js";
import {
  mapHermesEvent,
  parseHermesSse,
  type HermesSseEvent,
} from "./hermes-events.js";

export interface HermesAgentHarnessOptions {
  baseURL: string;
  apiKey: string;
  sessionId: string;
  skillName?: string;
  isVoice?: boolean;
  fetchImpl?: typeof fetch;
  catchAllLogger?: (event: unknown) => void;
}

interface StartRunResponse {
  run_id: string;
  status?: string;
}

const CAPABILITIES: AdapterCapabilities = {
  // Hermes ships experimental for voice cert until the cancel endpoint is
  // verified end-to-end. The implementation calls /cancel on abort but doesn't
  // wait for confirmation here.
  supports_confirmed_cancellation: false,
  survives_interruption: true,
  reliable_session_end: true,
  voice_certified: false,
};

export class HermesAgentHarness implements OrchestratorHarness {
  readonly provider = "hermes";
  readonly capabilities = CAPABILITIES;

  private readonly fetchImpl: typeof fetch;
  private readonly skillActivated = new Set<string>();
  private readonly catchAllLogger?: (event: unknown) => void;

  constructor(private readonly opts: HermesAgentHarnessOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.catchAllLogger = opts.catchAllLogger;
  }

  async *runTurn(request: HarnessTurnRequest): AsyncIterable<AdapterEvent> {
    const input = this.buildInput(request.prompt);

    let runId: string;
    try {
      const started = await this.startRun(input, request.abortSignal);
      runId = started.run_id;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start Hermes run";
      yield { type: "error", message, raw: { error: err } };
      yield { type: "session_end", subtype: "error", result: message, raw: { error: err } };
      return;
    }

    yield {
      type: "session_init",
      session_id: this.opts.sessionId,
      raw: { runId, hermesSessionId: this.opts.sessionId },
    };

    let cancelRequested = false;
    const cancelHandler = () => {
      cancelRequested = true;
      void this.sendCancel(runId);
    };
    request.abortSignal?.addEventListener("abort", cancelHandler, { once: true });

    try {
      yield* this.streamRun(runId, request.abortSignal);
    } finally {
      request.abortSignal?.removeEventListener("abort", cancelHandler);
      if (cancelRequested) {
        yield { type: "cancel_confirmed" };
      }
    }
  }

  private buildInput(prompt: string): string {
    let input = this.opts.isVoice ? wrapVoiceTurn(prompt) : prompt;
    if (this.opts.skillName && !this.skillActivated.has(this.opts.sessionId)) {
      input = prependSkillActivation(this.opts.skillName, input);
      this.skillActivated.add(this.opts.sessionId);
    }
    return input;
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "X-Hermes-Session-Id": this.opts.sessionId,
      ...extra,
    };
  }

  private async startRun(
    input: string,
    abortSignal?: AbortSignal,
  ): Promise<StartRunResponse> {
    const url = `${this.opts.baseURL.replace(/\/$/, "")}/v1/runs`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ input, session_id: this.opts.sessionId }),
      signal: abortSignal,
    });

    if (!res.ok) {
      const detail = await safeReadText(res);
      throw new Error(
        `Hermes /v1/runs failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
      );
    }

    const json = (await res.json()) as StartRunResponse;
    if (!json.run_id) {
      throw new Error("Hermes /v1/runs returned no run_id");
    }
    return json;
  }

  private async sendCancel(runId: string): Promise<void> {
    try {
      const url = `${this.opts.baseURL.replace(/\/$/, "")}/v1/runs/${runId}/cancel`;
      await this.fetchImpl(url, { method: "POST", headers: this.headers() });
    } catch {
      // Best effort — the SSE stream will close on abort regardless.
    }
  }

  private async *streamRun(
    runId: string,
    abortSignal?: AbortSignal,
  ): AsyncIterable<AdapterEvent> {
    const url = `${this.opts.baseURL.replace(/\/$/, "")}/v1/runs/${runId}/events`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({ Accept: "text/event-stream" }),
        signal: abortSignal,
      });
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      const message =
        err instanceof Error ? err.message : "Hermes events fetch failed";
      yield { type: "error", message, raw: { error: err, runId } };
      yield { type: "session_end", subtype: "error", result: message, raw: { runId } };
      return;
    }

    if (!res.ok || !res.body) {
      const detail = await safeReadText(res);
      const message = `Hermes events failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`;
      yield { type: "error", message, raw: { status: res.status, runId } };
      yield { type: "session_end", subtype: "error", result: message, raw: { runId } };
      return;
    }

    try {
      for await (const raw of parseHermesSse(res.body)) {
        this.catchAllLogger?.(raw);
        const result = mapHermesEvent(raw as HermesSseEvent);
        for (const e of result.events) yield e;
        if (result.done) return;
      }
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      const message =
        err instanceof Error ? err.message : "Hermes SSE parse error";
      yield { type: "error", message, raw: { error: err, runId } };
    }
  }
}

async function safeReadText(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return null;
  }
}

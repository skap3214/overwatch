/**
 * Hermes Agent harness — routes turns to a locally-running Hermes gateway
 * via its OpenAI-compatible HTTP API server.
 *
 * Wire protocol:
 *   1. POST /v1/runs    → returns { run_id } in HTTP 202
 *   2. GET /v1/runs/{run_id}/events  → SSE stream until run.completed/failed
 *
 * Voice turns are wrapped as <voice>...</voice> per the user's SOUL.md
 * convention. The first turn of each session prepends a synthetic skill
 * activation message that points at ~/.hermes/skills/<skillName>/.
 */

import type { HarnessEvent } from "../shared/events.js";
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
}

interface StartRunResponse {
  run_id: string;
  status?: string;
}

export class HermesAgentHarness implements OrchestratorHarness {
  private readonly fetchImpl: typeof fetch;
  private readonly skillActivated = new Set<string>();

  constructor(private readonly opts: HermesAgentHarnessOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *runTurn(request: HarnessTurnRequest): AsyncIterable<HarnessEvent> {
    const input = this.buildInput(request.prompt);

    let runId: string;
    try {
      const started = await this.startRun(input, request.abortSignal);
      runId = started.run_id;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start Hermes run";
      yield { type: "error", message, raw: { error: err } };
      return;
    }

    yield {
      type: "session_init",
      sessionId: this.opts.sessionId,
      raw: { runId, hermesSessionId: this.opts.sessionId },
    };

    yield* this.streamRun(runId, request.abortSignal);
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
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "X-Hermes-Session-Id": this.opts.sessionId,
      ...extra,
    };
    return h;
  }

  private async startRun(
    input: string,
    abortSignal?: AbortSignal,
  ): Promise<StartRunResponse> {
    const url = `${this.opts.baseURL.replace(/\/$/, "")}/v1/runs`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input,
        session_id: this.opts.sessionId,
      }),
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

  private async *streamRun(
    runId: string,
    abortSignal?: AbortSignal,
  ): AsyncIterable<HarnessEvent> {
    const url = `${this.opts.baseURL.replace(/\/$/, "")}/v1/runs/${runId}/events`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({ Accept: "text/event-stream" }),
        signal: abortSignal,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Hermes events fetch failed";
      yield { type: "error", message, raw: { error: err, runId } };
      return;
    }

    if (!res.ok || !res.body) {
      const detail = await safeReadText(res);
      yield {
        type: "error",
        message: `Hermes events failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
        raw: { status: res.status, runId },
      };
      return;
    }

    try {
      for await (const raw of parseHermesSse(res.body)) {
        const result = mapHermesEvent(raw as HermesSseEvent);
        if (result.event) yield result.event;
        if (result.error) {
          yield {
            type: "error",
            message: result.error,
            raw: { hermesEvent: raw, runId },
          };
        }
        if (result.done) return;
      }
    } catch (err) {
      // AbortError from fetch is expected when the user cancels — emit nothing.
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

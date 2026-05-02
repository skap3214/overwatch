/**
 * Translate Hermes SSE events to AdapterEvents.
 *
 * Source: GET /v1/runs/{run_id}/events
 * Each line is `data: <json>\n\n`. Each JSON object has an `event` field naming
 * the kind: tool.started | tool.completed | reasoning.available | message.delta |
 * message.completed | run.completed | run.failed.
 *
 * Critical invariant: every wire event is surfaced. Anything that does not map
 * cleanly to a Tier-1 canonical AdapterEvent is emitted as `provider_event`
 * with provider="hermes". Nothing is silently dropped.
 */

import type { AdapterEvent } from "../shared/events.js";

export interface HermesSseEvent {
  event: string;
  run_id?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface MapResult {
  events: AdapterEvent[];
  done?: boolean;
  error?: string;
}

export function mapHermesEvent(raw: HermesSseEvent): MapResult {
  switch (raw.event) {
    case "tool.started": {
      const tool =
        typeof raw.tool === "string"
          ? raw.tool
          : typeof raw.name === "string"
            ? raw.name
            : "tool";
      return {
        events: [
          {
            type: "tool_lifecycle",
            phase: "start",
            name: tool,
            tool_use_id:
              typeof raw.tool_use_id === "string" ? raw.tool_use_id : undefined,
            input: raw.input,
            raw,
          },
        ],
      };
    }
    case "tool.completed": {
      const tool =
        typeof raw.tool === "string"
          ? raw.tool
          : typeof raw.name === "string"
            ? raw.name
            : "tool";
      return {
        events: [
          {
            type: "tool_lifecycle",
            phase: "complete",
            name: tool,
            tool_use_id:
              typeof raw.tool_use_id === "string" ? raw.tool_use_id : undefined,
            result: raw.output ?? raw.result,
            raw,
          },
        ],
      };
    }
    case "reasoning.available": {
      const text =
        typeof raw.text === "string"
          ? raw.text
          : typeof raw.delta === "string"
            ? raw.delta
            : "";
      if (!text) return { events: [] };
      return { events: [{ type: "reasoning_delta", text, raw }] };
    }
    case "message.delta": {
      const text =
        typeof raw.delta === "string"
          ? raw.delta
          : typeof raw.text === "string"
            ? raw.text
            : "";
      if (!text) return { events: [] };
      return { events: [{ type: "text_delta", text, raw }] };
    }
    case "message.completed": {
      const text =
        typeof raw.text === "string"
          ? raw.text
          : typeof raw.output === "string"
            ? raw.output
            : "";
      if (!text) return { events: [] };
      return { events: [{ type: "assistant_message", text, raw }] };
    }
    case "run.completed":
      return {
        events: [
          {
            type: "session_end",
            subtype: "success",
            result:
              typeof raw.output === "string"
                ? raw.output
                : typeof raw.result === "string"
                  ? raw.result
                  : undefined,
            raw,
          },
        ],
        done: true,
      };
    case "run.failed": {
      const errObj =
        raw.error && typeof raw.error === "object"
          ? (raw.error as { message?: unknown })
          : null;
      const message =
        (errObj && typeof errObj.message === "string" && errObj.message) ||
        (typeof raw.message === "string" ? raw.message : "Hermes run failed");
      return {
        events: [
          { type: "error", message, raw },
          { type: "session_end", subtype: "error", result: message, raw },
        ],
        done: true,
        error: message,
      };
    }
    default:
      // Tier 2 passthrough — every unmapped event surfaces.
      return {
        events: [
          {
            type: "provider_event",
            provider: "hermes",
            kind: raw.event,
            payload: raw as unknown as Record<string, unknown>,
            raw,
          },
        ],
      };
  }
}

/**
 * Parse an SSE response body into HermesSseEvent objects.
 *
 * Hermes emits events as `data: {json}\n\n`. Comment lines (`:`) are keepalive
 * and ignored. We tolerate `event: <name>` lines too, but Hermes packs the
 * event name inside the JSON's `event` field, so we ignore that header.
 */
export async function* parseHermesSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<HermesSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let frameEnd: number;
      while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);

        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as HermesSseEvent;
          yield parsed;
        } catch {
          // Malformed line — skip rather than crash the stream.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

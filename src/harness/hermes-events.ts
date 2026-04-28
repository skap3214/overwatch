/**
 * Translate Hermes SSE events to Overwatch HarnessEvents.
 *
 * Source: GET /v1/runs/{run_id}/events
 * Each line is `data: <json>\n\n`. Each JSON object has an `event` field naming
 * the kind: tool.started | tool.completed | reasoning.available | message.delta |
 * run.completed | run.failed.
 */

import type { HarnessEvent } from "../shared/events.js";

export interface HermesSseEvent {
  event: string;
  run_id?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface MapResult {
  event?: HarnessEvent;
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
        event: { type: "tool_call", name: tool, raw },
      };
    }
    case "tool.completed":
      // Not currently surfaced — tool-pill UX uses tool.started only.
      return {};
    case "reasoning.available": {
      const text =
        typeof raw.text === "string"
          ? raw.text
          : typeof raw.delta === "string"
            ? raw.delta
            : "";
      if (!text) return {};
      return { event: { type: "reasoning_delta", text, raw } };
    }
    case "message.delta": {
      const text =
        typeof raw.delta === "string"
          ? raw.delta
          : typeof raw.text === "string"
            ? raw.text
            : "";
      if (!text) return {};
      return { event: { type: "text_delta", text, raw } };
    }
    case "message.completed": {
      const text =
        typeof raw.text === "string"
          ? raw.text
          : typeof raw.output === "string"
            ? raw.output
            : "";
      return text
        ? { event: { type: "assistant_message", text, raw } }
        : {};
    }
    case "run.completed":
      return { done: true };
    case "run.failed": {
      const errObj =
        raw.error && typeof raw.error === "object"
          ? (raw.error as { message?: unknown })
          : null;
      const message =
        (errObj && typeof errObj.message === "string" && errObj.message) ||
        (typeof raw.message === "string" ? raw.message : "Hermes run failed");
      return { done: true, error: message };
    }
    default:
      return {};
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

      // Frames are separated by blank lines.
      let frameEnd: number;
      while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);

        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue; // comment / keepalive
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
          // ignore other SSE fields (event:, id:, retry:)
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

import type { Context } from "hono";
import type { OrchestratorHarness } from "../harness/types.js";
import type { SttAdapter } from "../stt/types.js";
import type { TtsAdapter } from "../tts/types.js";
import { AsyncQueue } from "../shared/async-queue.js";

interface TurnDeps {
  harness: OrchestratorHarness;
  stt: SttAdapter;
  tts: TtsAdapter;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Access-Control-Allow-Origin": "*",
};

/**
 * Shared streaming logic: runs harness + TTS and writes SSE events.
 * Used by both voice and text turn handlers.
 */
function streamTurn(
  prompt: string,
  deps: TurnDeps,
  abortSignal: AbortSignal,
): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const write = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        } catch {
          // stream closed
        }
      };

      try {
        const textQueue = new AsyncQueue<string>();

        const harnessPromise = (async () => {
          try {
            for await (const event of deps.harness.runTurn({
              prompt,
              abortSignal,
            })) {
              if (event.type === "text_delta") {
                write("text_delta", { text: event.text });
                textQueue.push(event.text);
              } else if (event.type === "assistant_message") {
                write("assistant_message", { text: event.text });
              } else if (event.type === "tool_call") {
                write("tool_call", { name: event.name });
              } else if (event.type === "error") {
                write("error", { message: event.message });
              }
            }
          } finally {
            textQueue.end();
          }
        })();

        // TTS is best-effort — if the Cartesia WebSocket dies (e.g. during
        // a long tool call pause), the text stream must continue.
        const ttsPromise = (async () => {
          try {
            for await (const event of deps.tts.synthesize({
              textChunks: textQueue,
              abortSignal,
            })) {
              if (event.type === "audio_chunk") {
                const b64 = Buffer.from(event.data).toString("base64");
                write("audio_chunk", { base64: b64, mimeType: event.mimeType });
              } else if (event.type === "error") {
                write("tts_error", { message: event.message });
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "TTS error";
            write("tts_error", { message: msg });
          }
        })();

        await Promise.allSettled([harnessPromise, ttsPromise]);
        write("done", {});
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        try {
          controller.enqueue(encoder.encode(sseEvent("error", { message })));
        } catch {
          // stream already closed
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
}

/**
 * POST /api/v1/voice-turn — audio upload → STT → harness → TTS → SSE
 */
export function createVoiceTurnHandler(deps: TurnDeps) {
  return async (c: Context) => {
    const contentType = c.req.header("content-type") ?? "";

    let audioBytes: Uint8Array;
    let mimeType: string;

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const audioFile = formData.get("audio");
      if (!audioFile || !(audioFile instanceof File)) {
        return c.json({ error: "Missing 'audio' field in form data" }, 400);
      }
      audioBytes = new Uint8Array(await audioFile.arrayBuffer());
      mimeType = audioFile.type || "audio/webm";
    } else {
      audioBytes = new Uint8Array(await c.req.arrayBuffer());
      mimeType = contentType || "audio/webm";
    }

    if (audioBytes.length === 0) {
      return c.json({ error: "Empty audio body" }, 400);
    }

    const abortController = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abortController.abort(), {
      once: true,
    });

    // STT first, then stream the turn
    const sttResult = await deps.stt.transcribe({
      audio: audioBytes,
      mimeType,
      abortSignal: abortController.signal,
    });

    if (!sttResult.transcript.trim()) {
      return c.json({ error: "No speech detected" }, 400);
    }

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(sseEvent("transcript", { text: sttResult.transcript })),
        );

        const inner = streamTurn(
          sttResult.transcript,
          deps,
          abortController.signal,
        );
        const reader = inner.getReader();

        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } finally {
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        })();
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  };
}

/**
 * POST /api/v1/text-turn — JSON text → harness → TTS → SSE
 */
export function createTextTurnHandler(deps: TurnDeps) {
  return async (c: Context) => {
    const body: { text?: string } = await c.req.json().catch(() => ({}));
    const text = body.text?.trim();

    if (!text) {
      return c.json({ error: "Missing 'text' field" }, 400);
    }

    const abortController = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abortController.abort(), {
      once: true,
    });

    const stream = streamTurn(text, deps, abortController.signal);
    return new Response(stream, { headers: SSE_HEADERS });
  };
}

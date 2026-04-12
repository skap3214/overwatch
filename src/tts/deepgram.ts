import WebSocket, { RawData } from "ws";
import { AsyncQueue } from "../shared/async-queue.js";
import type { TtsAdapter, TtsSynthesisRequest } from "./types.js";
import type { TtsEvent } from "../shared/events.js";

interface DeepgramTtsAdapterOptions {
  apiKey?: string;
  model?: string;
}

const DEFAULT_DEEPGRAM_TTS_MODEL = "aura-2-aries-en";
const DEEPGRAM_TTS_SAMPLE_RATE = 24000;
const DEEPGRAM_TTS_MIME_TYPE = "audio/pcm;rate=24000";
const DEEPGRAM_TTS_MAX_CHARS = 2000;
const DEEPGRAM_TTS_TARGET_CHARS = 120;
const DEEPGRAM_TTS_MIN_BOUNDARY_CHARS = 24;

function isBoundaryChar(char: string): boolean {
  return /[.!?\n]/.test(char);
}

function splitForSend(buffer: string): [string | null, string] {
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (
      isBoundaryChar(buffer[i]!) &&
      (i + 1 >= DEEPGRAM_TTS_MIN_BOUNDARY_CHARS || buffer.length >= DEEPGRAM_TTS_TARGET_CHARS)
    ) {
      const next = i + 1;
      return [buffer.slice(0, next), buffer.slice(next)];
    }
  }

  if (buffer.length >= DEEPGRAM_TTS_TARGET_CHARS) {
    for (let i = Math.min(buffer.length - 1, DEEPGRAM_TTS_TARGET_CHARS); i >= 0; i--) {
      if (buffer[i] === " ") {
        return [buffer.slice(0, i), buffer.slice(i)];
      }
    }
  }

  if (buffer.length >= DEEPGRAM_TTS_MAX_CHARS) {
    let splitAt = buffer.lastIndexOf(" ", DEEPGRAM_TTS_MAX_CHARS);
    if (splitAt <= 0) {
      splitAt = DEEPGRAM_TTS_MAX_CHARS;
    }
    return [buffer.slice(0, splitAt), buffer.slice(splitAt)];
  }

  return [null, buffer];
}

export class DeepgramTtsAdapter implements TtsAdapter {
  private readonly apiKey?: string;
  private readonly model: string;

  constructor(options: DeepgramTtsAdapterOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_DEEPGRAM_TTS_MODEL;
  }

  async *synthesize(request: TtsSynthesisRequest): AsyncIterable<TtsEvent> {
    if (!this.apiKey) {
      yield {
        type: "error",
        message: "Deepgram TTS is not configured. Set DEEPGRAM_API_KEY.",
      };
      return;
    }

    const url = new URL("wss://api.deepgram.com/v1/speak");
    url.searchParams.set("model", this.model);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(DEEPGRAM_TTS_SAMPLE_RATE));
    url.searchParams.set("container", "none");

    const queue = new AsyncQueue<TtsEvent>();
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
      },
    });

    let receiverDone = false;
    let senderDone = false;
    let flushed = false;
    let awaitingFinalFlush = false;
    let abortError: Error | null = null;
    let pendingFlush:
      | {
          resolve: () => void;
          reject: (error: Error) => void;
        }
      | null = null;

    const finishIfReady = () => {
      if (receiverDone && senderDone) {
        queue.end();
      }
    };

    ws.on("message", (rawData: RawData, isBinary: boolean) => {
      if (isBinary) {
        queue.push({
          type: "audio_chunk",
          mimeType: DEEPGRAM_TTS_MIME_TYPE,
          data: new Uint8Array(rawData as Buffer),
        });
        return;
      }

      const text = rawData.toString();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (type === "Flushed") {
        if (pendingFlush) {
          const pending = pendingFlush;
          pendingFlush = null;
          if (awaitingFinalFlush) {
            flushed = true;
            receiverDone = true;
          }
          pending.resolve();
        }
      } else if (type === "Warning") {
        const description =
          typeof parsed.description === "string"
            ? parsed.description
            : "Deepgram TTS warning";
        console.warn(`[TTS] ${description}`);
      } else if (type === "Error") {
        const description =
          typeof parsed.description === "string"
            ? parsed.description
            : "Deepgram TTS error";
        if (pendingFlush) {
          pendingFlush.reject(new Error(description));
          pendingFlush = null;
        }
        queue.fail(new Error(description));
      }
    });

    ws.on("error", (error: Error) => {
      if (pendingFlush) {
        pendingFlush.reject(error);
        pendingFlush = null;
      }
      queue.fail(error);
    });

    ws.on("close", (_code: number, reason: Buffer) => {
      if (abortError) {
        if (pendingFlush) {
          pendingFlush.reject(abortError);
          pendingFlush = null;
        }
        queue.fail(abortError);
        return;
      }
      if (pendingFlush) {
        const error = new Error(reason.toString("utf-8") || "Deepgram TTS connection closed");
        pendingFlush.reject(error);
        pendingFlush = null;
      }
      if (!flushed && !receiverDone) {
        const message = reason.toString("utf-8") || "Deepgram TTS connection closed";
        queue.fail(new Error(message));
        return;
      }
      receiverDone = true;
      finishIfReady();
    });

    const opened = new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const sendJson = (payload: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(payload));
    };

    const sendFlush = async (phase: "incremental" | "final") => {
      await new Promise<void>((resolve, reject) => {
        pendingFlush = {
          resolve,
          reject,
        };
        sendJson({ type: "Flush" });
      });

      if (phase === "final") {
        sendJson({ type: "Close" });
      }
    };

    const sender = (async () => {
      let buffer = "";
      try {
        await opened;
        for await (const chunk of request.textChunks) {
          if (!chunk) continue;
          buffer += chunk;

          while (true) {
            const [nextChunk, remainder] = splitForSend(buffer);
            if (!nextChunk) {
              buffer = remainder;
              break;
            }
            sendJson({ type: "Speak", text: nextChunk });
            await sendFlush("incremental");
            buffer = remainder;
          }
        }

        if (buffer.trim()) {
          sendJson({ type: "Speak", text: buffer });
        }
        awaitingFinalFlush = true;
        await sendFlush("final");
      } catch {
        // Abort or WS close rejected pendingFlush — expected during cancellation
      } finally {
        senderDone = true;
        finishIfReady();
      }
    })();

    const abortHandler = () => {
      abortError = new Error("Deepgram TTS aborted");
      try {
        sendJson({ type: "Close" });
      } catch {}
      try {
        ws.close();
      } catch {}
    };

    request.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    try {
      for await (const event of queue) {
        yield event;
      }
      await sender;
    } finally {
      request.abortSignal?.removeEventListener("abort", abortHandler);
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        try {
          sendJson({ type: "Close" });
        } catch {}
        ws.close();
      }
    }
  }
}

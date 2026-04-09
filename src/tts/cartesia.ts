import { randomUUID } from "node:crypto";
import WebSocket, { RawData } from "ws";
import { AsyncQueue } from "../shared/async-queue.js";
import type { TtsAdapter, TtsSynthesisRequest } from "./types.js";
import type { TtsEvent } from "../shared/events.js";

interface CartesiaTtsAdapterOptions {
  apiKey?: string;
}

const DEFAULT_CARTESIA_VOICE_ID = "a167e0f3-df7e-4d52-a9c3-f949145efdab";
const CARTESIA_VERSION = "2026-03-01";
const CARTESIA_MODEL_ID = "sonic-3";
const CARTESIA_SAMPLE_RATE = 24000;
const CARTESIA_MIME_TYPE = "audio/pcm;rate=24000";

/**
 * Opens a fresh Cartesia WebSocket, sends all text chunks from the iterator,
 * and yields audio events. If the WebSocket dies, returns control so the
 * caller can open a new one for remaining text.
 */
async function* synthesizeSegment(
  apiKey: string,
  voiceId: string,
  textIter: AsyncIterable<string>,
  abortSignal?: AbortSignal,
): AsyncGenerator<TtsEvent, string[], never> {
  const queue = new AsyncQueue<TtsEvent>();
  const contextId = randomUUID();
  const leftover: string[] = [];
  let wsDead = false;

  const ws = new WebSocket("wss://api.cartesia.ai/tts/websocket", {
    headers: {
      "X-API-Key": apiKey,
      "Cartesia-Version": CARTESIA_VERSION,
    },
  });

  const sendPayload = (transcript: string, shouldContinue: boolean) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        model_id: CARTESIA_MODEL_ID,
        transcript,
        voice: { mode: "id", id: voiceId },
        language: "en",
        context_id: contextId,
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: CARTESIA_SAMPLE_RATE,
        },
        add_timestamps: false,
        continue: shouldContinue,
        max_buffer_delay_ms: 120,
      }),
    );
  };

  ws.on("message", (rawData: RawData) => {
    const text = rawData.toString("utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "chunk" && typeof parsed.data === "string") {
      queue.push({
        type: "audio_chunk",
        mimeType: CARTESIA_MIME_TYPE,
        data: Buffer.from(parsed.data, "base64"),
      });
    } else if (type === "done") {
      queue.end();
      ws.close();
    } else if (type === "error") {
      queue.fail(
        new Error(
          typeof parsed.error === "string" ? parsed.error : "Cartesia TTS error",
        ),
      );
    }
  });

  ws.on("error", () => {
    wsDead = true;
    queue.end();
  });

  ws.on("close", () => {
    wsDead = true;
    queue.end();
  });

  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  // Sender: pump text chunks into the WebSocket
  const sender = (async () => {
    try {
      await opened;
      for await (const chunk of textIter) {
        if (!chunk) continue;
        if (wsDead) {
          // WebSocket died — save remaining chunks for next segment
          leftover.push(chunk);
          continue;
        }
        sendPayload(chunk, true);
      }
      if (!wsDead) {
        // Signal end of text
        sendPayload("", false);
      }
    } catch {
      wsDead = true;
      try { ws.close(); } catch {}
    }
  })();

  abortSignal?.addEventListener(
    "abort",
    () => {
      wsDead = true;
      queue.end();
      try { ws.close(); } catch {}
    },
    { once: true },
  );

  try {
    for await (const event of queue) {
      yield event;
    }
    await sender;
  } finally {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close();
    }
  }

  return leftover;
}

export class CartesiaTtsAdapter implements TtsAdapter {
  readonly apiKey?: string;
  readonly voiceId: string;

  constructor(options: CartesiaTtsAdapterOptions = {}) {
    this.apiKey = options.apiKey;
    this.voiceId = DEFAULT_CARTESIA_VOICE_ID;
  }

  async *synthesize(request: TtsSynthesisRequest): AsyncIterable<TtsEvent> {
    if (!this.apiKey || !this.voiceId) {
      yield {
        type: "error",
        message:
          "Cartesia TTS is not configured. Set CARTESIA_API_KEY and CARTESIA_VOICE_ID.",
      };
      return;
    }

    // Use a wrapper that can be "split" — when the WebSocket dies, we
    // collect leftover text and open a new connection for it.
    let textSource: AsyncIterable<string> = request.textChunks;
    let attempts = 0;
    const MAX_RECONNECTS = 3;

    while (attempts <= MAX_RECONNECTS) {
      if (request.abortSignal?.aborted) break;

      const gen = synthesizeSegment(
        this.apiKey,
        this.voiceId,
        textSource,
        request.abortSignal,
      );

      // Yield all audio events from this segment
      let result: IteratorResult<TtsEvent, string[]>;
      while (true) {
        result = await gen.next();
        if (result.done) break;
        yield result.value;
      }

      const leftover = result.value;
      if (!leftover || leftover.length === 0) {
        // No leftover text — all text was spoken
        break;
      }

      // WebSocket died with unsent text — reconnect
      attempts++;
      console.log(
        `[TTS] WebSocket died with ${leftover.length} unsent chunks, reconnecting (attempt ${attempts})`,
      );

      // Create an async iterable from the leftover chunks
      textSource = (async function* () {
        for (const chunk of leftover) {
          yield chunk;
        }
      })();
    }
  }
}

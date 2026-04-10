import type { SttAdapter, SttRequest } from "./types.js";
import type { SttResult } from "../shared/events.js";

interface DeepgramSttAdapterOptions {
  apiKey?: string;
  keyterms?: string[];
}

export class DeepgramSttAdapter implements SttAdapter {
  private static readonly DEFAULT_KEYTERMS = ["Claude", "Codex", "tmux"];
  private readonly apiKey?: string;
  private readonly keyterms: string[];

  constructor(options: DeepgramSttAdapterOptions = {}) {
    this.apiKey = options.apiKey;
    this.keyterms = options.keyterms ?? DeepgramSttAdapter.DEFAULT_KEYTERMS;
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    if (!this.apiKey) {
      throw new Error("Deepgram STT is not configured. Set DEEPGRAM_API_KEY.");
    }

    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", "nova-3");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("smart_format", "true");
    for (const keyterm of this.keyterms) {
      if (keyterm.trim()) {
        url.searchParams.append("keyterm", keyterm);
      }
    }
    if (request.language) {
      url.searchParams.set("language", request.language);
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": request.mimeType || "audio/webm",
      },
      body: Buffer.from(request.audio),
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Deepgram STT failed: ${response.status} ${errorText}`);
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const transcript =
      ((((raw.results as Record<string, unknown> | undefined)?.channels as Array<Record<string, unknown>> | undefined)?.[0]
        ?.alternatives as Array<Record<string, unknown>> | undefined)?.[0]?.transcript as string | undefined) ?? "";

    return { transcript, raw };
  }
}

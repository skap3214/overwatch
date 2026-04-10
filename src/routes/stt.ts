import type { Context } from "hono";
import type { SttAdapter } from "../stt/types.js";

interface SttDeps {
  stt: SttAdapter;
}

async function parseAudioRequest(c: Context): Promise<{
  audioBytes: Uint8Array;
  mimeType: string;
}> {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const audioFile = formData.get("audio");
    if (!audioFile || !(audioFile instanceof File)) {
      throw new Error("Missing 'audio' field in form data");
    }

    return {
      audioBytes: new Uint8Array(await audioFile.arrayBuffer()),
      mimeType: audioFile.type || "audio/webm",
    };
  }

  return {
    audioBytes: new Uint8Array(await c.req.arrayBuffer()),
    mimeType: contentType || "audio/webm",
  };
}

export function createSttHandler(deps: SttDeps) {
  return async (c: Context) => {
    try {
      const { audioBytes, mimeType } = await parseAudioRequest(c);
      if (audioBytes.length === 0) {
        return c.json({ error: "Empty audio body" }, 400);
      }

      const abortController = new AbortController();
      c.req.raw.signal.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });

      const result = await deps.stt.transcribe({
        audio: audioBytes,
        mimeType,
        language: c.req.query("language") ?? "en",
        abortSignal: abortController.signal,
      });

      return c.json({ transcript: result.transcript, raw: result.raw });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "STT request failed";
      const status = message.startsWith("Missing 'audio'") ? 400 : 500;
      return c.json({ error: message }, status);
    }
  };
}

import type { SSEEvent } from "../types";

export async function checkHealth(baseURL: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseURL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

type SSECallback = (event: SSEEvent) => void;
type SSEDone = () => void;
type SSEError = (err: Error) => void;

function streamSSE(
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: any },
  signal: AbortSignal,
  onEvent: SSECallback,
  onDone: SSEDone,
  onError: SSEError
) {
  const xhr = new XMLHttpRequest();
  xhr.open(options.method, url);

  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      xhr.setRequestHeader(key, value);
    }
  }

  let lastIndex = 0;
  let eventType: string | null = null;
  let lineBuffer = "";

  xhr.onprogress = () => {
    const newData = xhr.responseText.substring(lastIndex);
    lastIndex = xhr.responseText.length;

    // Prepend any leftover partial line from previous call
    const toParse = lineBuffer + newData;
    const lines = toParse.split("\n");
    // Last element may be incomplete — save it for next time
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("event: ")) {
        eventType = trimmed.slice(7).trim();
      } else if (trimmed.startsWith("data: ") && eventType) {
        try {
          const data = JSON.parse(trimmed.slice(6));
          onEvent({ type: eventType, data } as SSEEvent);
        } catch {
          // skip malformed data
        }
        eventType = null;
      }
    }
  };

  xhr.onload = () => onDone();
  xhr.onerror = () => onError(new Error("Network error"));
  xhr.ontimeout = () => onError(new Error("Request timeout"));

  signal.addEventListener("abort", () => xhr.abort());

  xhr.send(options.body ?? null);
}

export function textTurn(
  baseURL: string,
  text: string,
  signal: AbortSignal,
  onEvent: SSECallback,
  onDone: SSEDone,
  onError: SSEError
) {
  streamSSE(
    `${baseURL}/api/v1/text-turn`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
    signal,
    onEvent,
    onDone,
    onError
  );
}

export function voiceTurn(
  baseURL: string,
  audioUri: string,
  mimeType: string,
  signal: AbortSignal,
  onEvent: SSECallback,
  onDone: SSEDone,
  onError: SSEError
) {
  const formData = new FormData();
  formData.append("audio", {
    uri: audioUri,
    type: mimeType,
    name: "recording.wav",
  } as any);

  streamSSE(
    `${baseURL}/api/v1/voice-turn`,
    { method: "POST", body: formData },
    signal,
    onEvent,
    onDone,
    onError
  );
}

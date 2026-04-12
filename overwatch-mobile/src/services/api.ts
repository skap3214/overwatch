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

export async function transcribeAudio(
  audioUri: string,
  mimeType: string,
  deepgramApiKey: string,
  signal?: AbortSignal
): Promise<string> {
  const t0 = Date.now();
  // Read audio file as binary (React Native Blob lacks .arrayBuffer())
  const response = await fetch(audioUri);
  const blob = await response.blob();
  const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  console.log(`[perf]   read audio file: ${Date.now() - t0}ms (${arrayBuffer.byteLength} bytes)`);

  // Map common mobile mime types to Deepgram-compatible ones
  const dgMime = mimeType === "audio/m4a" ? "audio/mp4" : mimeType;

  const t1 = Date.now();
  const res = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${deepgramApiKey}`,
        "Content-Type": dgMime,
      },
      body: arrayBuffer,
      signal,
    }
  );

  console.log(`[perf]   deepgram API call: ${Date.now() - t1}ms (status ${res.status})`);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Deepgram STT failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{ transcript?: string }>;
      }>;
    };
  };

  const transcript =
    json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
  if (!transcript) {
    throw new Error("No speech detected");
  }

  return transcript;
}

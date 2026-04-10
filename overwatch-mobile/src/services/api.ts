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
  baseURL: string,
  audioUri: string,
  mimeType: string,
  signal?: AbortSignal
): Promise<string> {
  const formData = new FormData();
  formData.append("audio", {
    uri: audioUri,
    type: mimeType,
    name: "recording.wav",
  } as any);

  const res = await fetch(`${baseURL}/api/v1/stt`, {
    method: "POST",
    body: formData,
    signal,
  });

  const json = (await res.json().catch(() => ({}))) as {
    transcript?: string;
    error?: string;
  };

  if (!res.ok) {
    throw new Error(json.error || `STT failed with status ${res.status}`);
  }

  const transcript = json.transcript?.trim() ?? "";
  if (!transcript) {
    throw new Error("No speech detected");
  }

  return transcript;
}

import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { PiCodingAgentHarness } from "./harness/pi-coding-agent.js";
import { DeepgramSttAdapter } from "./stt/deepgram.js";
import { CartesiaTtsAdapter } from "./tts/cartesia.js";
import { createVoiceTurnHandler, createTextTurnHandler } from "./routes/voice-turn.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// In dev (tsx): __dirname is src/, so web/ is a sibling. In prod (dist/): go up to root then into src/web.
const WEB_DIR = __dirname.endsWith("/src/")
  ? join(__dirname, "web")
  : join(__dirname, "..", "src", "web");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const config = loadConfig();
const harness = new PiCodingAgentHarness();
const tts = new CartesiaTtsAdapter({
  apiKey: config.CARTESIA_API_KEY,
});
const stt = new DeepgramSttAdapter({
  apiKey: config.DEEPGRAM_API_KEY,
});

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    harness: "pi-coding-agent",
    tts: tts.constructor.name,
    stt: stt.constructor.name,
  }),
);

app.get("/debug/harness", async (c) => {
  const prompt = c.req.query("prompt") ?? "Reply with exactly one short line.";
  const events: unknown[] = [];
  for await (const event of harness.runTurn({ prompt })) {
    events.push(event);
  }
  return c.json({ events });
});

app.get("/debug/tts", async (c) => {
  const text = c.req.query("text") ?? "Hello from Overwatch.";
  async function* textChunks() {
    yield text;
  }

  const events: Array<Record<string, unknown>> = [];
  for await (const event of tts.synthesize({ textChunks: textChunks() })) {
    events.push(
      event.type === "audio_chunk"
        ? {
            type: event.type,
            mimeType: event.mimeType,
            bytes: event.data.byteLength,
          }
        : event,
    );
  }
  return c.json({ events });
});

app.post("/debug/stt", async (c) => {
  const arrayBuffer = await c.req.arrayBuffer();
  const transcript = await stt.transcribe({
    audio: new Uint8Array(arrayBuffer),
    mimeType: c.req.header("content-type") ?? "audio/webm",
    language: c.req.query("language") ?? "en",
  });
  return c.json(transcript);
});

// Voice turn route — end-to-end SSE: audio → STT → harness → TTS → client
const turnDeps = { harness, stt, tts };
app.post("/api/v1/voice-turn", createVoiceTurnHandler(turnDeps));
app.post("/api/v1/text-turn", createTextTurnHandler(turnDeps));

// Static file serving for the web frontend
app.get("/*", async (c) => {
  let filePath = c.req.path === "/" ? "/index.html" : c.req.path;
  const fullPath = join(WEB_DIR, filePath);

  // Prevent directory traversal
  if (!fullPath.startsWith(WEB_DIR)) {
    return c.text("Forbidden", 403);
  }

  try {
    const content = await readFile(fullPath);
    const ext = extname(fullPath);
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    return new Response(content, {
      headers: { "Content-Type": mime },
    });
  } catch {
    return c.text("Not found", 404);
  }
});

console.log(`[overwatch] starting on http://localhost:${config.PORT}`);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[overwatch] listening on http://localhost:${info.port}`);
});

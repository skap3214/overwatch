import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessEvent } from "../shared/events.js";
import type { HarnessTurnRequest, OrchestratorHarness } from "./types.js";

interface ClaudeCliHarnessOptions {
  claudePath?: string;
  extraArgs?: string[];
  systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are Overwatch, a voice-controlled orchestrator for tmux-hosted coding sessions. You help the user manage and coordinate Claude Code and other agent sessions running in tmux panes.

Your responses are spoken aloud via text-to-speech. Follow these rules strictly:

- Keep sentences short and natural. Prefer 1-3 sentences unless the user asks for detail.
- Never use markdown formatting, bullet points, numbered lists, or code blocks.
- Speak as if you are talking to someone in the room. Be warm and conversational.
- When performing tasks, briefly narrate what you are doing. "Let me check that..." or "Running it now..."
- For long outputs like file contents or command results, summarize verbally rather than reading everything aloud.
- Numbers and technical terms are fine. Say "port 3001" not "port three thousand and one."
- If you do not know something, say so simply.
- Do not use phrases like "as an AI." Just be natural.
- Do not narrate routine tool calls. Just do it and report the result. Only narrate when the task will take a while or when the user would be confused by silence.`;

function mapClaudeJsonLine(parsed: Record<string, unknown>): HarnessEvent | null {
  const type = typeof parsed.type === "string" ? parsed.type : undefined;
  if (!type) return null;

  if (type === "system" && parsed.subtype === "init") {
    return {
      type: "session_init",
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
      tools: Array.isArray(parsed.tools)
        ? parsed.tools.filter((tool): tool is string => typeof tool === "string")
        : undefined,
      raw: parsed,
    };
  }

  if (type === "stream_event") {
    const event = parsed.event;
    if (!event || typeof event !== "object") return null;

    const streamEvent = event as Record<string, unknown>;
    if (streamEvent.type === "content_block_delta") {
      const delta = streamEvent.delta;
      if (!delta || typeof delta !== "object") return null;
      const text = (delta as Record<string, unknown>).text;
      if (typeof text === "string" && text.length > 0) {
        return { type: "text_delta", text, raw: parsed };
      }
    }
    return null;
  }

  if (type === "assistant") {
    const message = parsed.message;
    if (!message || typeof message !== "object") return null;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return null;
    const text = content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const typed = block as Record<string, unknown>;
        return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
      })
      .join("");
    return { type: "assistant_message", text, raw: parsed };
  }

  if (type === "result") {
    return {
      type: "result",
      text: typeof parsed.result === "string" ? parsed.result : "",
      raw: parsed,
    };
  }

  return null;
}

export class ClaudeCodeCliHarness implements OrchestratorHarness {
  private readonly claudePath: string;
  private readonly extraArgs: string[];
  private readonly systemPrompt: string;

  constructor(options: ClaudeCliHarnessOptions = {}) {
    this.claudePath = options.claudePath ?? "claude";
    this.extraArgs = options.extraArgs ?? [];
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async *runTurn(request: HarnessTurnRequest): AsyncIterable<HarnessEvent> {
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--system-prompt",
      this.systemPrompt,
      ...this.extraArgs,
      request.prompt,
    ];

    const child = spawn(this.claudePath, args, {
      cwd: request.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    request.abortSignal?.addEventListener(
      "abort",
      () => {
        child.kill("SIGTERM");
      },
      { once: true },
    );

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (!line.trim()) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const event = mapClaudeJsonLine(parsed);
      if (event) {
        yield event;
      }
    }

    const exitCode: number = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    if (exitCode !== 0) {
      yield {
        type: "error",
        message: stderr.trim() || `claude exited with code ${exitCode}`,
        raw: { exitCode, stderr },
      };
    }
  }
}

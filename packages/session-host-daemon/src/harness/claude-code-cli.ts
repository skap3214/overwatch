import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AdapterEvent, AdapterCapabilities } from "../shared/events.js";
import type { HarnessTurnRequest, OrchestratorHarness } from "./types.js";

interface ClaudeCliHarnessOptions {
  claudePath?: string;
  extraArgs?: string[];
  systemPrompt?: string;
  catchAllLogger?: (event: unknown) => void;
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
- Do not narrate routine tool calls. Just do it and report the result.`;

/**
 * Translate a single line of stream-json from `claude -p` into one or more
 * AdapterEvents. Returns an empty array (not null) when nothing maps.
 *
 * Critical invariant: every wire-event path is covered. Anything that does not
 * map to a Tier-1 canonical event is emitted as a `provider_event` so the
 * cloud orchestrator's catch-all logger can see it. Nothing is silently dropped.
 */
function mapClaudeJsonLine(parsed: Record<string, unknown>): AdapterEvent[] {
  const type = typeof parsed.type === "string" ? parsed.type : undefined;
  if (!type) return [];

  // ─── Tier 1 — canonical cross-provider mappings ─────────────────────────

  if (type === "system" && parsed.subtype === "init") {
    const tools = Array.isArray(parsed.tools)
      ? parsed.tools.filter((t): t is string => typeof t === "string")
      : undefined;
    return [
      {
        type: "session_init",
        session_id:
          typeof parsed.session_id === "string" ? parsed.session_id : undefined,
        tools,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
        raw: parsed,
      },
    ];
  }

  if (type === "stream_event") {
    const event = parsed.event as Record<string, unknown> | undefined;
    if (!event || typeof event !== "object") return [];
    if (event.type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return [];
      if (typeof delta.text === "string" && delta.text.length > 0) {
        return [{ type: "text_delta", text: delta.text, raw: parsed }];
      }
      if (typeof delta.thinking === "string" && delta.thinking.length > 0) {
        return [{ type: "reasoning_delta", text: delta.thinking, raw: parsed }];
      }
    }
    return [];
  }

  if (type === "assistant") {
    const message = parsed.message as Record<string, unknown> | undefined;
    if (!message) return [];
    const content = message.content;
    if (!Array.isArray(content)) return [];
    const out: AdapterEvent[] = [];
    let textParts = "";
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts += block.text;
      } else if (block.type === "tool_use") {
        out.push({
          type: "tool_lifecycle",
          phase: "start",
          name: typeof block.name === "string" ? block.name : "",
          tool_use_id:
            typeof block.id === "string" ? block.id : undefined,
          input: block.input,
          raw: parsed,
        });
      }
    }
    if (textParts) {
      out.push({ type: "assistant_message", text: textParts, raw: parsed });
    }
    return out;
  }

  if (type === "user") {
    // Claude streams tool_result blocks as `user` messages. Surface as tool_lifecycle.complete.
    const message = parsed.message as Record<string, unknown> | undefined;
    if (!message) return [];
    const content = message.content;
    if (!Array.isArray(content)) return [];
    const out: AdapterEvent[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "tool_result") {
        out.push({
          type: "tool_lifecycle",
          phase: "complete",
          name: "",
          tool_use_id:
            typeof block.tool_use_id === "string"
              ? block.tool_use_id
              : undefined,
          result: block.content ?? block,
          raw: parsed,
        });
      }
    }
    return out;
  }

  if (type === "result") {
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "success";
    const isError = subtype.startsWith("error");
    return [
      {
        type: "session_end",
        subtype: isError ? "error" : "success",
        result: typeof parsed.result === "string" ? parsed.result : undefined,
        cost_usd:
          typeof parsed.total_cost_usd === "number"
            ? parsed.total_cost_usd
            : undefined,
        usage:
          typeof parsed.usage === "object" && parsed.usage !== null
            ? (parsed.usage as { input?: number; output?: number; [k: string]: unknown })
            : undefined,
        raw: parsed,
      },
    ];
  }

  // ─── Tier 2 — provider_event passthrough for everything else ────────────
  // compact_boundary, plugin_install, hooks, task_progress, files_persisted,
  // rate_limit, auth_status, prompt_suggestion, tool_use_summary, etc.

  return [
    {
      type: "provider_event",
      provider: "claude-code",
      kind: type,
      payload: parsed as Record<string, unknown>,
      raw: parsed,
    },
  ];
}

const CAPABILITIES: AdapterCapabilities = {
  supports_confirmed_cancellation: true, // SIGTERM → process exit is the confirmation
  survives_interruption: true, // --include-partial-messages leaves clean partial state
  reliable_session_end: true, // every run emits result
  voice_certified: true,
};

export class ClaudeCodeCliHarness implements OrchestratorHarness {
  readonly provider = "claude-code";
  readonly capabilities = CAPABILITIES;

  private readonly claudePath: string;
  private readonly extraArgs: string[];
  private readonly systemPrompt: string;
  private readonly catchAllLogger?: (event: unknown) => void;

  constructor(options: ClaudeCliHarnessOptions = {}) {
    this.claudePath = options.claudePath ?? "claude";
    this.extraArgs = options.extraArgs ?? [];
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.catchAllLogger = options.catchAllLogger;
  }

  async *runTurn(request: HarnessTurnRequest): AsyncIterable<AdapterEvent> {
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

    let cancelRequested = false;
    request.abortSignal?.addEventListener(
      "abort",
      () => {
        cancelRequested = true;
        child.kill("SIGTERM");
      },
      { once: true },
    );

    let stderr = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
    }

    if (!child.stdout) {
      throw new Error("claude subprocess started without stdout");
    }
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (!line.trim()) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      this.catchAllLogger?.(parsed);

      for (const event of mapClaudeJsonLine(parsed)) {
        yield event;
      }
    }

    const exitCode: number = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 0));
    });

    if (cancelRequested) {
      yield { type: "cancel_confirmed" };
      return;
    }

    if (exitCode !== 0) {
      yield {
        type: "error",
        message: stderr.trim() || `claude exited with code ${exitCode}`,
        raw: { exitCode, stderr },
      };
    }
  }
}

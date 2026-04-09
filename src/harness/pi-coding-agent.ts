/**
 * Pi-coding-agent harness — runs the Anthropic API directly via
 * pi-coding-agent as a library. No Claude CLI subprocess.
 *
 * Minimal setup: coding tools, system prompt, streaming events,
 * scheduler support, and persistent memory.
 */

import { getModel } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  codingTools,
  AuthStorage,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { HarnessEvent } from "../shared/events.js";
import type { HarnessTurnRequest, OrchestratorHarness } from "./types.js";
import { AsyncQueue } from "../shared/async-queue.js";
import { schedulerExtension } from "../extensions/scheduler.js";
import { memoryExtension } from "../extensions/memory.js";

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
- Do not narrate routine tool calls. Just do it and report the result. Only narrate when the task will take a while or when the user would be confused by silence.

## tmux quirks

When injecting text into tmux panes, different agents require different submission patterns:

- Codex (OpenAI): Use \`tmux send-keys -t <pane> -l "your prompt"\` for the text (literal mode), then a separate \`tmux send-keys -t <pane> Enter\` to submit. A single send-keys with Enter embedded in the string does not work — it just drops to a new line inside the Codex prompt.
- Claude Code: Accepts input normally via send-keys without needing literal mode.

Always use the two-step pattern (literal text, then separate Enter) as the safe default.`;
const SESSION_INSPECTION_GUIDANCE = `

## Session inspection policy

When the user asks about tmux sessions, running agents, or what different sessions contain:

- inspect live tmux state first using tmux commands
- do not rely only on memory or prior notes
- if memory exists, use it only as supplemental context after checking live tmux state
- do not ask the user for session numbers until you have first tried to inspect the tmux server yourself
`;

interface PiCodingAgentHarnessOptions {
  apiKey?: string;
  modelId?: string;
  systemPrompt?: string;
  cwd?: string;
}

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class PiCodingAgentHarness implements OrchestratorHarness {
  private readonly apiKey?: string;
  private readonly modelId: string;
  private readonly systemPrompt: string;
  private readonly defaultCwd: string;
  private session: Session | null = null;

  constructor(options: PiCodingAgentHarnessOptions = {}) {
    this.apiKey = options.apiKey;
    this.modelId = options.modelId ?? "claude-sonnet-4-6";
    this.systemPrompt =
      options.systemPrompt ?? `${DEFAULT_SYSTEM_PROMPT}${SESSION_INSPECTION_GUIDANCE}`;
    this.defaultCwd = options.cwd ?? process.cwd();
  }

  private async ensureSession(): Promise<Session> {
    if (this.session) return this.session;

    const authStorage = AuthStorage.create();
    if (this.apiKey && !authStorage.get("anthropic")) {
      authStorage.setRuntimeApiKey("anthropic", this.apiKey);
    }

    const cwd = this.defaultCwd;
    const settingsManager = SettingsManager.create(cwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      settingsManager,
      systemPrompt: this.systemPrompt,
      extensionFactories: [schedulerExtension(), memoryExtension()],
      noThemes: true,
    });
    await resourceLoader.reload();

    const model = getModel("anthropic", this.modelId as any);

    const { session } = await createAgentSession({
      cwd,
      model,
      thinkingLevel: "off",
      tools: codingTools,
      resourceLoader,
      sessionManager: SessionManager.create(cwd),
      settingsManager,
      authStorage,
    });

    await session.bindExtensions({});
    this.session = session;
    return session;
  }

  async *runTurn(request: HarnessTurnRequest): AsyncIterable<HarnessEvent> {
    const session = await this.ensureSession();
    const queue = new AsyncQueue<HarnessEvent>();

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          queue.push({
            type: "text_delta",
            text: ame.delta,
            raw: event,
          });
        }
      } else if (event.type === "tool_execution_start") {
        queue.push({
          type: "tool_call",
          name: event.toolName,
          raw: event,
        });
      }
    });

    const promptTask = (async () => {
      try {
        await session.prompt(request.prompt, { streamingBehavior: "followUp" });
        // Collect the full assistant text from the session after the turn
        const stats = session.getSessionStats();
        queue.push({
          type: "result",
          text: "",
          raw: { usage: { input: stats.tokens.input, output: stats.tokens.output } },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        queue.push({
          type: "error",
          message,
          raw: { error: err },
        });
      } finally {
        unsubscribe();
        queue.end();
      }
    })();

    for await (const event of queue) {
      yield event;
    }
    await promptTask;
  }

  dispose(): void {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
  }
}

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

- Codex (OpenAI) and Cursor Agent: Use \`tmux send-keys -t <pane> -l "your prompt"\` for the text (literal mode), then a separate \`tmux send-keys -t <pane> Enter\` to submit. A single send-keys with Enter embedded in the string does not work — it just drops to a new line inside their prompt.
- Claude Code and OpenCode: Accept input normally via send-keys without needing literal mode.

Always use the two-step pattern (literal text, then separate Enter) as the safe default for all agents.

## Managing agent sessions

You are responsible for keeping agent sessions productive. Most users run agents with default permissions (not bypassed), which means agents will pause and wait for approval before executing commands, writing files, or accessing the network.

### Permission prompts

When you send a task to an agent, monitor its pane with \`tmux capture-pane -t <pane> -p\` to check for permission/approval prompts. Different agents show these differently:

- Claude Code: numbered selector (1. Yes / 2. Yes for session / 3. No). Send \`Enter\` to accept the pre-selected first option. Use \`Up\`/\`Down\` arrows to navigate options.
- Codex: either letter keys (\`a\` accept, \`s\` session, \`d\` decline) or arrow-key menu where first option is pre-selected. Send \`Enter\` to approve.
- OpenCode: \`a\` to allow once, \`A\` (shift) to allow for session, \`d\` to deny.
- Cursor Agent: \`y\` to approve, \`n\` to reject. Use \`--yolo --trust\` at launch to skip prompts.

When you detect a permission prompt, approve it by default — the user asked you to perform the task, so the agent needs permission to do its work. If the prompt looks destructive or risky (deleting files, force pushing, dropping databases, running unfamiliar scripts), pause and ask the user before approving.

### Detecting agent state

After sending a task to an agent, poll its pane periodically to track progress:

1. Check if the agent is still working (output streaming, spinner visible)
2. Check if it is blocked on a permission prompt (approve it)
3. Check if it has finished (prompt/input area reappears, "Done" or completion message visible)
4. Check if it errored (error messages, stack traces)

Report results back to the user conversationally. If an agent errors, read the error and either fix the issue or explain what went wrong.

### Escalation

Escalate to the user (ask before acting) when:
- An agent wants to do something destructive (rm -rf, git push --force, drop table)
- An agent is asking a question that requires the user's judgment or preference
- An agent has failed repeatedly on the same task
- You are unsure which agent or session to target
- The task is ambiguous and could be interpreted multiple ways

Do not escalate for routine approvals — just approve and move on.

### Multi-agent coordination

When the user has multiple agent sessions running:
- Keep track of which session is doing what by inspecting pane content
- Avoid sending conflicting tasks to agents working in the same directory
- If one agent's output is needed as input for another, wait for the first to finish before proceeding
- Summarize cross-session status when the user asks "what's going on" or "how's it going"`;
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

    // Wire abort signal to session.abort() so the LLM call stops
    const abortHandler = () => { session.abort().catch(() => {}); };
    if (request.abortSignal?.aborted) {
      abortHandler();
    } else {
      request.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    }

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
        request.abortSignal?.removeEventListener("abort", abortHandler);
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

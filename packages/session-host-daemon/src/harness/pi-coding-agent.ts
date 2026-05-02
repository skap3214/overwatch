/**
 * Pi-coding-agent harness — runs the Anthropic API directly via
 * pi-coding-agent as a library. No Claude CLI subprocess.
 *
 * Critical invariant: never silently drop a wire event. Anything from
 * `session.subscribe()` that doesn't map to a Tier-1 canonical AdapterEvent
 * is emitted as a `provider_event` with provider="pi".
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
import type { AdapterEvent, AdapterCapabilities } from "../shared/events.js";
import type { HarnessTurnRequest, OrchestratorHarness } from "./types.js";
import { AsyncQueue } from "../shared/async-queue.js";
import { schedulerExtension } from "../extensions/scheduler.js";
import { memoryExtension } from "../extensions/memory.js";

const DEFAULT_SYSTEM_PROMPT = `You are Overwatch, a voice-controlled orchestrator for tmux-hosted coding sessions.

- Keep sentences short and natural. Prefer 1-3 sentences unless the user asks for detail.
- Never use markdown formatting, bullet points, numbered lists, or code blocks.
- Speak as if you are talking to someone in the room.
- For long outputs, summarize verbally.`;

const CAPABILITIES: AdapterCapabilities = {
  supports_confirmed_cancellation: true, // session.abort() resolves the prompt promise
  survives_interruption: true,
  reliable_session_end: true,
  voice_certified: true,
};

interface PiCodingAgentHarnessOptions {
  apiKey?: string;
  modelId?: string;
  systemPrompt?: string;
  cwd?: string;
  catchAllLogger?: (event: unknown) => void;
}

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class PiCodingAgentHarness implements OrchestratorHarness {
  readonly provider = "pi";
  readonly capabilities = CAPABILITIES;

  private readonly apiKey?: string;
  private readonly modelId: string;
  private readonly systemPrompt: string;
  private readonly defaultCwd: string;
  private readonly catchAllLogger?: (event: unknown) => void;
  private session: Session | null = null;
  private pendingPrompt: Promise<void> = Promise.resolve();

  constructor(options: PiCodingAgentHarnessOptions = {}) {
    this.apiKey = options.apiKey;
    this.modelId = options.modelId ?? "claude-sonnet-4-6";
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.defaultCwd = options.cwd ?? process.cwd();
    this.catchAllLogger = options.catchAllLogger;
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

  async *runTurn(request: HarnessTurnRequest): AsyncIterable<AdapterEvent> {
    const session = await this.ensureSession();
    await this.pendingPrompt.catch(() => {});

    const queue = new AsyncQueue<AdapterEvent>();
    let cancelRequested = false;

    const abortHandler = () => {
      cancelRequested = true;
      session.abort().catch(() => {});
    };
    if (request.abortSignal?.aborted) {
      abortHandler();
    } else {
      request.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    }

    yield {
      type: "session_init",
      session_id: undefined,
      raw: { provider: "pi", correlation_id: request.correlation_id },
    };

    const unsubscribe = session.subscribe((event: any) => {
      this.catchAllLogger?.(event);
      const mapped = mapPiEvent(event);
      for (const e of mapped) queue.push(e);
    });

    const promptTask = (async () => {
      try {
        await session.prompt(request.prompt, { streamingBehavior: "followUp" });
        if (!cancelRequested) {
          const stats = session.getSessionStats();
          queue.push({
            type: "session_end",
            subtype: "success",
            usage: {
              input: stats.tokens.input,
              output: stats.tokens.output,
            },
            raw: { stats },
          });
        }
      } catch (err) {
        if (cancelRequested) {
          // Expected: aborted prompt
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        queue.push({ type: "error", message, raw: { error: err } });
        queue.push({
          type: "session_end",
          subtype: "error",
          result: message,
          raw: { error: err },
        });
      } finally {
        request.abortSignal?.removeEventListener("abort", abortHandler);
        unsubscribe();
        if (cancelRequested) {
          queue.push({ type: "cancel_confirmed" });
        }
        queue.end();
      }
    })();

    this.pendingPrompt = promptTask.then(
      () => {},
      () => {},
    );

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

/**
 * Translate a single Pi `session.subscribe()` event into AdapterEvents.
 *
 * Tier-1 maps for the canonical event shapes; Tier-2 provider_event passthrough
 * for everything else (thinking deltas, tool_use_start, tool_execution_end,
 * extension events, etc.).
 *
 * Exported under `mapPiEventForTest` so unit tests can exercise the mapping
 * without spinning up a real Pi session.
 */
export { mapPiEvent as mapPiEventForTest };

function mapPiEvent(event: any): AdapterEvent[] {
  const type = event?.type;
  if (typeof type !== "string") return [];

  if (type === "message_update") {
    const ame = event.assistantMessageEvent;
    const ameType = ame?.type;
    if (ameType === "text_delta") {
      return [{ type: "text_delta", text: ame.delta, raw: event }];
    }
    if (ameType === "thinking_delta") {
      return [
        { type: "reasoning_delta", text: ame.delta ?? "", raw: event },
      ];
    }
    if (ameType === "tool_use_start") {
      return [
        {
          type: "tool_lifecycle",
          phase: "start",
          name: ame.toolName ?? "",
          tool_use_id: ame.toolUseId,
          input: ame.input,
          raw: event,
        },
      ];
    }
    return [
      {
        type: "provider_event",
        provider: "pi",
        kind: `message_update/${ameType ?? "unknown"}`,
        payload: event,
        raw: event,
      },
    ];
  }

  if (type === "tool_execution_start") {
    return [
      {
        type: "tool_lifecycle",
        phase: "start",
        name: event.toolName ?? "",
        tool_use_id: event.toolUseId,
        input: event.input,
        raw: event,
      },
    ];
  }

  if (type === "tool_execution_end") {
    return [
      {
        type: "tool_lifecycle",
        phase: "complete",
        name: event.toolName ?? "",
        tool_use_id: event.toolUseId,
        result: event.result ?? event.output,
        raw: event,
      },
    ];
  }

  // Tier-2 passthrough for everything else.
  return [
    {
      type: "provider_event",
      provider: "pi",
      kind: type,
      payload: event,
      raw: event,
    },
  ];
}

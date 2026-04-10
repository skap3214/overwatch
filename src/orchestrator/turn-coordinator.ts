import { AsyncQueue } from "../shared/async-queue.js";
import type { OrchestratorHarness } from "../harness/types.js";
import type { TtsAdapter } from "../tts/types.js";
import { notificationStore } from "../notifications/store.js";
import { EventEmitter } from "node:events";

type ForegroundSend = (event: string, data: unknown) => void;

type BaseJob = {
  id: string;
  prompt: string;
};

type ForegroundJob = BaseJob & {
  kind: "foreground";
  send: ForegroundSend;
  abortSignal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
};

type BackgroundJob = BaseJob & {
  kind: "background";
  source: {
    type: "scheduler" | "agent" | "system";
    id?: string;
  };
  title: string;
  summary: string;
};

type QueuedJob = ForegroundJob | BackgroundJob;

type CoordinatorRealtimeEvents = {
  event: [string, Record<string, unknown>];
};

class CoordinatorEmitter extends EventEmitter {
  emit<K extends keyof CoordinatorRealtimeEvents>(
    event: K,
    ...args: CoordinatorRealtimeEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof CoordinatorRealtimeEvents>(
    event: K,
    listener: (...args: CoordinatorRealtimeEvents[K]) => void
  ): this {
    return super.on(event, listener);
  }

  off<K extends keyof CoordinatorRealtimeEvents>(
    event: K,
    listener: (...args: CoordinatorRealtimeEvents[K]) => void
  ): this {
    return super.off(event, listener);
  }
}

export class TurnCoordinator {
  private readonly queue: QueuedJob[] = [];
  private currentJob: QueuedJob | null = null;
  private processing = false;
  private readonly emitter = new CoordinatorEmitter();

  constructor(
    private readonly harness: OrchestratorHarness,
    private readonly tts: TtsAdapter
  ) {}

  async runForegroundTurn(params: {
    prompt: string;
    send: ForegroundSend;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const job: ForegroundJob = {
        id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: "foreground",
        prompt: params.prompt,
        send: params.send,
        abortSignal: params.abortSignal,
        resolve,
        reject,
      };

      const queuedAhead =
        (this.currentJob ? 1 : 0) + this.queue.length;
      if (queuedAhead > 0) {
        params.send("turn.queued", {
          turnId: job.id,
          position: queuedAhead,
        });
      }

      this.queue.push(job);
      this.kick();
    });
  }

  enqueueBackgroundTurn(params: {
    prompt: string;
    source: {
      type: "scheduler" | "agent" | "system";
      id?: string;
    };
    title: string;
    summary: string;
  }): void {
    const job: BackgroundJob = {
      id: `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: "background",
      prompt: params.prompt,
      source: params.source,
      title: params.title,
      summary: params.summary,
    };

    const queuedAhead =
      (this.currentJob ? 1 : 0) + this.queue.length;
    if (queuedAhead > 0) {
      notificationStore.create({
        kind: "scheduled_task_status",
        title: `${params.title} queued`,
        body: params.summary,
        speakableText: `${params.title} queued.`,
        source: params.source,
        metadata: {
          queuePosition: queuedAhead,
          jobId: job.id,
        },
      });
    }

    this.queue.push(job);
    this.kick();
  }

  subscribe(
    listener: (eventType: string, payload: Record<string, unknown>) => void
  ): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  private kick(): void {
    if (this.processing) return;
    this.processing = true;
    queueMicrotask(() => void this.processLoop());
  }

  private async processLoop(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        this.currentJob = job;
        if (job.kind === "foreground") {
          await this.executeForeground(job);
        } else {
          await this.executeBackground(job);
        }
        this.currentJob = null;
      }
    } finally {
      this.currentJob = null;
      this.processing = false;
      if (this.queue.length > 0) this.kick();
    }
  }

  private async executeForeground(job: ForegroundJob): Promise<void> {
    if (job.abortSignal?.aborted) {
      job.send("turn.error", { turnId: job.id, message: "Turn cancelled" });
      job.reject(new Error("Turn cancelled"));
      return;
    }
    job.send("turn.started", { turnId: job.id });
    const textQueue = new AsyncQueue<string>();

    const harnessPromise = (async () => {
      try {
        for await (const event of this.harness.runTurn({
          prompt: job.prompt,
          abortSignal: job.abortSignal,
        })) {
          if (event.type === "text_delta") {
            job.send("turn.text_delta", { turnId: job.id, text: event.text });
            textQueue.push(event.text);
          } else if (event.type === "assistant_message") {
            job.send("turn.assistant_message", {
              turnId: job.id,
              text: event.text,
            });
          } else if (event.type === "tool_call") {
            job.send("turn.tool_call", { turnId: job.id, name: event.name });
          } else if (event.type === "error") {
            job.send("turn.error", { turnId: job.id, message: event.message });
          }
        }
      } finally {
        textQueue.end();
      }
    })();

    const ttsPromise = (async () => {
      try {
        for await (const event of this.tts.synthesize({
          textChunks: textQueue,
          abortSignal: job.abortSignal,
        })) {
          if (event.type === "audio_chunk") {
            const base64 = Buffer.from(event.data).toString("base64");
            job.send("turn.audio_chunk", {
              turnId: job.id,
              base64,
              mimeType: event.mimeType,
            });
          } else if (event.type === "error") {
            job.send("turn.tts_error", {
              turnId: job.id,
              message: event.message,
            });
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "TTS error";
        job.send("turn.tts_error", { turnId: job.id, message });
      }
    })();

    try {
      await Promise.allSettled([harnessPromise, ttsPromise]);
      job.send("turn.done", { turnId: job.id });
      job.resolve();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Foreground turn failed";
      job.send("turn.error", { turnId: job.id, message });
      job.reject(error instanceof Error ? error : new Error(message));
    }
  }

  private async executeBackground(job: BackgroundJob): Promise<void> {
    this.emitter.emit("event", "background.turn_started", {
      turnId: job.id,
      title: job.title,
      prompt: job.prompt,
      summary: job.summary,
    });

    let text = "";
    let errorMessage: string | null = null;
    const textQueue = new AsyncQueue<string>();

    const harnessPromise = (async () => {
      try {
        for await (const event of this.harness.runTurn({
          prompt: job.prompt,
        })) {
          if (event.type === "text_delta") {
            text += event.text;
            textQueue.push(event.text);
            this.emitter.emit("event", "background.turn_text_delta", {
              turnId: job.id,
              text: event.text,
            });
          } else if (event.type === "assistant_message" && !text) {
            text = event.text;
          } else if (event.type === "tool_call") {
            this.emitter.emit("event", "background.turn_tool_call", {
              turnId: job.id,
              name: event.name,
            });
          } else if (event.type === "error") {
            errorMessage = event.message;
          }
        }
      } catch (error) {
        errorMessage =
          error instanceof Error ? error.message : "Background task failed";
      } finally {
        textQueue.end();
      }
    })();

    const ttsPromise = (async () => {
      try {
        for await (const event of this.tts.synthesize({
          textChunks: textQueue,
        })) {
          if (event.type === "audio_chunk") {
            this.emitter.emit("event", "background.turn_audio_chunk", {
              turnId: job.id,
              base64: Buffer.from(event.data).toString("base64"),
              mimeType: event.mimeType,
            });
          } else if (event.type === "error") {
            this.emitter.emit("event", "background.turn_tts_error", {
              turnId: job.id,
              message: event.message,
            });
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Background TTS error";
        this.emitter.emit("event", "background.turn_tts_error", {
          turnId: job.id,
          message,
        });
      }
    })();

    await Promise.allSettled([harnessPromise, ttsPromise]);

    if (errorMessage) {
      this.emitter.emit("event", "background.turn_error", {
        turnId: job.id,
        message: errorMessage,
      });
      notificationStore.create({
        kind: "scheduled_task_error",
        title: `${job.title} failed`,
        body: errorMessage,
        speakableText: `${job.title} failed. ${errorMessage}`,
        source: job.source,
        metadata: { jobId: job.id, summary: job.summary },
      });
      return;
    }

    this.emitter.emit("event", "background.turn_done", {
      turnId: job.id,
    });
    notificationStore.create({
      kind: "scheduled_task_result",
      title: `${job.title} completed`,
      body: text.trim() || job.summary,
      speakableText: text.trim() || `${job.title} completed.`,
      source: job.source,
      metadata: { jobId: job.id, summary: job.summary },
    });
  }
}

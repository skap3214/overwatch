/**
 * HermesJobsBridge — polls /api/jobs every N seconds, translates to
 * ScheduledMonitor, and emits transitions.
 *
 * Hermes does not expose any push channel for job state. We poll. On each tick:
 *   - GET /api/jobs?include_disabled=true
 *   - translate each Hermes job → ScheduledMonitor
 *   - notify subscribers of the new snapshot
 *   - detect last_run_at advancing → emit a Notification (Phase 5)
 *   - detect transitions to/from running/paused → emit a Notification of kind status
 */

import { EventEmitter } from "node:events";
import type { ScheduledMonitor } from "../extensions/scheduler.js";
import type { MonitorSource } from "./monitor-source.js";

export interface HermesJob {
  id: string;
  name: string;
  prompt: string;
  skills?: string[];
  skill?: string | null;
  schedule_display?: string;
  schedule?: { kind?: string; minutes?: number; display?: string };
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: "ok" | "error" | null;
  last_error?: string | null;
  last_delivery_error?: string | null;
  enabled?: boolean;
  state?: string;
  paused_at?: string | null;
  paused_reason?: string | null;
  repeat?: { times: number | null; completed: number } | null;
  deliver?: string;
}

export interface HermesJobsBridgeOptions {
  baseURL: string;
  apiKey: string;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  onJobFired?: (job: HermesJob, prevLastRunAt: string | null) => void;
}

type Events = {
  changed: [ScheduledMonitor[]];
};

class BridgeEmitter extends EventEmitter {
  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    return super.emit(event, ...args);
  }
  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    return super.on(event, listener);
  }
  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    return super.off(event, listener);
  }
}

export function hermesJobToMonitor(job: HermesJob): ScheduledMonitor {
  const scheduleKind = job.schedule?.kind ?? "";
  const recurring = scheduleKind !== "one_shot" && scheduleKind !== "datetime";
  return {
    id: job.id,
    title: job.name,
    scheduleLabel: job.schedule_display ?? job.schedule?.display ?? "",
    nextRunAt: job.next_run_at ?? null,
    lastFiredAt: job.last_run_at ?? null,
    recurring,
    enabled: job.enabled ?? true,
    state: job.state,
    lastStatus: job.last_status ?? null,
    lastError: job.last_error ?? null,
    paused: !!job.paused_at,
    repeat: job.repeat ?? null,
    source: "hermes",
  };
}

export class HermesJobsBridge implements MonitorSource {
  private readonly emitter = new BridgeEmitter();
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: ScheduledMonitor[] = [];
  private latestById = new Map<string, HermesJob>();
  private running = false;

  constructor(private readonly opts: HermesJobsBridgeOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
    console.log(
      `[hermes-jobs] polling ${this.opts.baseURL}/api/jobs every ${this.pollIntervalMs}ms`,
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  list(): ScheduledMonitor[] {
    return this.latest;
  }

  subscribe(listener: (monitors: ScheduledMonitor[]) => void): () => void {
    this.emitter.on("changed", listener);
    return () => this.emitter.off("changed", listener);
  }

  /** Force a poll outside the timer — used by REST shim after mutations. */
  async refresh(): Promise<ScheduledMonitor[]> {
    return this.poll();
  }

  /** Read-side helper: get a raw Hermes job by id (for run history etc.). */
  getRawJob(id: string): HermesJob | undefined {
    return this.latestById.get(id);
  }

  private async poll(): Promise<ScheduledMonitor[]> {
    if (!this.running) return this.latest;
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.opts.baseURL.replace(/\/$/, "")}/api/jobs?include_disabled=true`,
        {
          headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        },
      );
    } catch (err) {
      // Hermes likely down or unreachable — keep last snapshot, log once per minute.
      this.warnOnce(`[hermes-jobs] poll failed: ${err instanceof Error ? err.message : err}`);
      return this.latest;
    }
    if (!res.ok) {
      this.warnOnce(`[hermes-jobs] /api/jobs ${res.status}`);
      return this.latest;
    }
    let data: { jobs?: HermesJob[] };
    try {
      data = (await res.json()) as { jobs?: HermesJob[] };
    } catch (err) {
      this.warnOnce(`[hermes-jobs] parse failed: ${err instanceof Error ? err.message : err}`);
      return this.latest;
    }
    const jobs = data.jobs ?? [];
    const monitors = jobs.map(hermesJobToMonitor);

    // Detect transitions
    const prevById = this.latestById;
    const nextById = new Map<string, HermesJob>();
    for (const job of jobs) {
      nextById.set(job.id, job);
      const prev = prevById.get(job.id);
      const prevLast = prev?.last_run_at ?? null;
      const curLast = job.last_run_at ?? null;
      if (curLast && prevLast !== curLast) {
        try {
          this.opts.onJobFired?.(job, prevLast);
        } catch (err) {
          console.warn(
            `[hermes-jobs] onJobFired threw: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    this.latest = monitors;
    this.latestById = nextById;
    this.emitter.emit("changed", monitors);
    return monitors;
  }

  private lastWarnTs = 0;
  private warnOnce(msg: string): void {
    const now = Date.now();
    if (now - this.lastWarnTs < 60_000) return;
    this.lastWarnTs = now;
    console.warn(msg);
  }
}

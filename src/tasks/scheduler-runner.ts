import { Cron } from "croner";
import {
  loadScheduledTasks,
  saveScheduledTasks,
  type ScheduledTask,
} from "../extensions/scheduler.js";
import { TurnCoordinator } from "../orchestrator/turn-coordinator.js";

const TICK_MS = 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class SchedulerRunner {
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly coordinator: TurnCoordinator) {}

  start(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
    if (this.tickInterval.unref) this.tickInterval.unref();
    console.log("[scheduler-runner] Tick pump started");
  }

  stop(): void {
    if (!this.tickInterval) return;
    clearInterval(this.tickInterval);
    this.tickInterval = null;
    console.log("[scheduler-runner] Tick pump stopped");
  }

  private tick(): void {
    const tasks = loadScheduledTasks();
    const now = Date.now();
    const retained: ScheduledTask[] = [];

    for (const task of tasks) {
      if (task.recurring && now - task.createdAt > MAX_AGE_MS) {
        console.log(`[scheduler-runner] Expired old task ${task.id}`);
        continue;
      }

      const lastFired = task.lastFiredAt ?? 0;
      const minSpacingMs = task.intervalMs
        ? Math.max(1000, Math.min(task.intervalMs - 500, task.intervalMs))
        : 55_000;
      if (lastFired > 0 && now - lastFired < minSpacingMs) {
        retained.push(task);
        continue;
      }

      try {
        const nextFireAt = task.intervalMs
          ? (task.lastFiredAt ?? task.createdAt) + task.intervalMs
          : (() => {
              const cron = new Cron(task.cron);
              const next = cron.nextRun();
              return next ? next.getTime() : null;
            })();
        if (!nextFireAt) {
          retained.push(task);
          continue;
        }

        const msToNext = nextFireAt - now;
        if (msToNext <= 1500 && msToNext >= -5000) {
          console.log(
            `[scheduler-runner] Queueing task ${task.id}: ${task.prompt.slice(0, 50)}`
          );

          this.coordinator.enqueueBackgroundTurn({
            prompt: `[Scheduled task ${task.id}]: ${task.prompt}`,
            source: { type: "scheduler", id: task.id },
            title: task.description || `Scheduled task ${task.id}`,
            summary: task.prompt,
          });

          task.lastFiredAt = now;
          if (task.recurring) {
            retained.push(task);
          }
        } else {
          retained.push(task);
        }
      } catch {
        retained.push(task);
      }
    }

    saveScheduledTasks(retained);
  }
}

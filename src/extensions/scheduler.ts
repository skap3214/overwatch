/**
 * Scheduler extension — recurring and one-shot scheduled tasks.
 *
 * Ported from halo-2's pi-agent scheduler. Stripped of Pi-specific
 * functionality (SSH, TTS announcements). Uses the same cron-based
 * tick pump pattern.
 *
 * When a task fires, sends a user message to the agent via pi.sendUserMessage().
 * The agent can then act on it (e.g. check tmux, run a command, etc.)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TASKS_DIR = join(homedir(), ".overwatch");
const TASKS_PATH = join(TASKS_DIR, "scheduled_tasks.json");
const TICK_MS = 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ScheduledTask {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: number;
  lastFiredAt?: number;
  description?: string;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function loadScheduledTasks(): ScheduledTask[] {
  if (!existsSync(TASKS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(TASKS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

export function saveScheduledTasks(tasks: ScheduledTask[]): void {
  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2), "utf-8");
}

export function intervalToCron(interval: string): string | null {
  const match = interval.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return n < 60 ? "* * * * *" : `*/${Math.ceil(n / 60)} * * * *`;
    case "m":
      return n <= 59
        ? `*/${n} * * * *`
        : `0 */${Math.ceil(n / 60)} * * *`;
    case "h":
      return n <= 23 ? `0 */${n} * * *` : `0 0 */${Math.ceil(n / 24)} * *`;
    case "d":
      return `0 0 */${n} * *`;
    default:
      return null;
  }
}

export function getNextFireTime(cronExpr: string): Date | null {
  try {
    return new Cron(cronExpr).nextRun() ?? null;
  } catch {
    return null;
  }
}

function formatTask(task: ScheduledTask): string {
  const type = task.recurring ? "recurring" : "one-shot";
  const next = getNextFireTime(task.cron);
  const nextStr = next ? next.toLocaleString() : "unknown";
  const desc = task.description ? ` — ${task.description}` : "";
  return `[${task.id}] ${type} (${task.cron}) next: ${nextStr}${desc}\n  prompt: "${task.prompt.slice(0, 100)}"`;
}

export function createScheduledTask(params: {
  prompt: string;
  interval?: string;
  cron?: string;
  recurring?: boolean;
  description?: string;
}): { task: ScheduledTask; nextFireTime: Date | null } {
  let cronExpr = params.cron;
  if (!cronExpr && params.interval) {
    cronExpr = intervalToCron(params.interval) ?? undefined;
    if (!cronExpr) {
      throw new Error(
        `Invalid interval: ${params.interval}. Use format like 5m, 2h, 1d.`
      );
    }
  }
  if (!cronExpr) throw new Error("Either interval or cron is required.");

  try {
    new Cron(cronExpr);
  } catch {
    throw new Error(`Invalid cron expression: ${cronExpr}`);
  }

  const recurring = params.recurring ?? (params.interval ? true : false);
  const task: ScheduledTask = {
    id: randomUUID().slice(0, 8),
    cron: cronExpr,
    prompt: params.prompt,
    recurring,
    createdAt: Date.now(),
    description: params.description,
  };

  const tasks = loadScheduledTasks();
  tasks.push(task);
  saveScheduledTasks(tasks);

  return { task, nextFireTime: getNextFireTime(cronExpr) };
}

export function deleteScheduledTask(taskId: string): ScheduledTask | null {
  const tasks = loadScheduledTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  const [removed] = tasks.splice(idx, 1);
  saveScheduledTasks(tasks);
  return removed ?? null;
}

export function schedulerExtension() {
  let tasks: ScheduledTask[] = [];
  let tickInterval: ReturnType<typeof setInterval> | null = null;
  let agentBusy = false;

  return (pi: ExtensionAPI) => {
    // Load tasks immediately
    tasks = loadScheduledTasks();
    if (tasks.length > 0) {
      console.log(`[scheduler] Loaded ${tasks.length} scheduled task(s)`);
    }

    // Start the tick pump
    tickInterval = setInterval(() => tick(pi), TICK_MS);
    if (tickInterval.unref) tickInterval.unref();
    console.log("[scheduler] Tick pump started");

    // Reload tasks on session start
    pi.on("session_start", () => {
      tasks = loadScheduledTasks();
    });

    // Track busy state
    pi.on("turn_start", () => {
      agentBusy = true;
    });
    pi.on("turn_end", () => {
      agentBusy = false;
    });
    pi.on("agent_end", () => {
      agentBusy = false;
    });

    // Clean up on shutdown
    pi.on("session_shutdown", () => {
      if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
        console.log("[scheduler] Tick pump stopped");
      }
    });

    function tick(pi: ExtensionAPI) {
      tasks = loadScheduledTasks();
      if (agentBusy) return;

      const now = Date.now();
      const toDelete: string[] = [];

      for (const task of tasks) {
        // Expire old recurring tasks
        if (task.recurring && now - task.createdAt > MAX_AGE_MS) {
          toDelete.push(task.id);
          console.log(`[scheduler] Expired old task ${task.id}`);
          continue;
        }

        // Debounce: don't fire more than once per 55 seconds
        const lastFired = task.lastFiredAt ?? 0;
        if (now - lastFired < 55_000) continue;

        try {
          const cron = new Cron(task.cron);
          const next = cron.nextRun();
          if (!next) continue;

          const msToNext = next.getTime() - now;

          // Fire when within 1.5 seconds of fire time
          if (msToNext <= 1500 && msToNext >= -5000) {
            console.log(
              `[scheduler] Firing task ${task.id}: ${task.prompt.slice(0, 50)}`
            );

            pi.sendUserMessage(
              `[Scheduled task ${task.id}]: ${task.prompt}`
            );

            task.lastFiredAt = now;
            saveScheduledTasks(tasks);

            if (!task.recurring) {
              toDelete.push(task.id);
            }
            // Only fire one task per tick
            break;
          }
        } catch {
          // Invalid cron, skip
        }
      }

      if (toDelete.length > 0) {
        tasks = tasks.filter((t) => !toDelete.includes(t.id));
        saveScheduledTasks(tasks);
      }
    }

    // schedule_create
    pi.registerTool({
      name: "schedule_create",
      label: "Schedule Task",
      description:
        "Create a scheduled task that runs a prompt on an interval or at a specific time. " +
        "Supports cron expressions or simple intervals (5m, 30m, 2h, 1d). " +
        "Use this to set up periodic monitoring of tmux sessions, reminders, or any recurring check.",
      promptSnippet: "Schedule recurring or one-shot tasks.",
      promptGuidelines: [
        "Use schedule_create for periodic tmux session checks, reminders, or recurring tasks.",
        "Simple intervals: 5m, 30m, 2h, 1d. Or use cron expressions for precise scheduling.",
        "The prompt will be sent as a user message when the task fires. Include what you want to check or do.",
      ],
      parameters: Type.Object({
        prompt: Type.String({
          description: "The prompt to run when the task fires.",
        }),
        interval: Type.Optional(
          Type.String({ description: "Simple interval: 5m, 30m, 2h, 1d." })
        ),
        cron: Type.Optional(
          Type.String({
            description:
              "Cron expression (5 fields). Takes precedence over interval.",
          })
        ),
        recurring: Type.Optional(
          Type.Boolean({
            description:
              "Whether to repeat. Defaults to true for intervals, false for cron.",
          })
        ),
        description: Type.Optional(
          Type.String({ description: "Human-readable description." })
        ),
      }),
      async execute(_toolCallId, params) {
        const { task, nextFireTime } = createScheduledTask(params);
        tasks = loadScheduledTasks();
        return ok(
          `Scheduled task ${task.id} (${task.recurring ? "recurring" : "one-shot"}). Next fire: ${nextFireTime?.toLocaleString() ?? "unknown"}`
        );
      },
    });

    // schedule_list
    pi.registerTool({
      name: "schedule_list",
      label: "List Schedules",
      description: "List all scheduled tasks.",
      promptSnippet: "List all scheduled tasks.",
      parameters: Type.Object({}),
      async execute() {
        tasks = loadScheduledTasks();
        if (tasks.length === 0) return ok("No scheduled tasks.");
        return ok(tasks.map(formatTask).join("\n\n"));
      },
    });

    // schedule_delete
    pi.registerTool({
      name: "schedule_delete",
      label: "Delete Schedule",
      description: "Delete a scheduled task by its ID.",
      promptSnippet: "Delete a scheduled task.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to delete." }),
      }),
      async execute(_toolCallId, params) {
        const removed = deleteScheduledTask(params.taskId);
        if (!removed) throw new Error(`Task not found: ${params.taskId}`);
        tasks = loadScheduledTasks();
        return ok(
          `Deleted task ${removed.id}: "${removed.prompt.slice(0, 80)}"`
        );
      },
    });
  };
}

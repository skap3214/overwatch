/**
 * Scheduler extension — recurring and one-shot scheduled tasks.
 *
 * Ported from halo-2's pi-agent scheduler. In Overwatch, this extension
 * only provides task creation/list/delete tools. Actual due-task execution
 * is handled by the backend scheduler runner so tasks can be queued,
 * surfaced to mobile clients, and captured as background results.
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

export interface ScheduledTask {
  id: string;
  cron: string;
  intervalMs?: number;
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

export function intervalToMs(interval: string): number | null {
  const match = interval.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    case "d":
      return n * 24 * 60 * 60 * 1000;
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
  const next =
    task.intervalMs && task.recurring
      ? new Date((task.lastFiredAt ?? task.createdAt) + task.intervalMs)
      : getNextFireTime(task.cron);
  const nextStr = next ? next.toLocaleString() : "unknown";
  const desc = task.description ? ` — ${task.description}` : "";
  const schedule = task.intervalMs
    ? `every ${Math.round(task.intervalMs / 1000)}s`
    : task.cron;
  return `[${task.id}] ${type} (${schedule}) next: ${nextStr}${desc}\n  prompt: "${task.prompt.slice(0, 100)}"`;
}

export function createScheduledTask(params: {
  prompt: string;
  interval?: string;
  cron?: string;
  recurring?: boolean;
  description?: string;
}): { task: ScheduledTask; nextFireTime: Date | null } {
  let cronExpr = params.cron;
  let intervalMs: number | undefined;
  if (!cronExpr && params.interval) {
    intervalMs = intervalToMs(params.interval) ?? undefined;
    cronExpr = intervalToCron(params.interval) ?? undefined;
    if (!intervalMs || !cronExpr) {
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
    intervalMs,
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
  return (pi: ExtensionAPI) => {
    // schedule_create
    pi.registerTool({
      name: "schedule_create",
      label: "Schedule Task",
      description:
        "Create a scheduled task that runs a prompt on an interval or at a specific time. " +
        "Supports cron expressions or simple intervals (10s, 30s, 5m, 2h, 1d). " +
        "Use this to set up periodic monitoring of tmux sessions, reminders, or any recurring check.",
      promptSnippet: "Schedule recurring or one-shot tasks.",
      promptGuidelines: [
        "Use schedule_create for periodic tmux session checks, reminders, or recurring tasks.",
        "Simple intervals: 10s, 30s, 5m, 2h, 1d. Or use cron expressions for precise scheduling.",
        "The prompt will be sent as a user message when the task fires. Include what you want to check or do.",
      ],
      parameters: Type.Object({
        prompt: Type.String({
          description: "The prompt to run when the task fires.",
        }),
        interval: Type.Optional(
          Type.String({ description: "Simple interval: 10s, 30s, 5m, 2h, 1d." })
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
        const tasks = loadScheduledTasks();
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
        return ok(
          `Deleted task ${removed.id}: "${removed.prompt.slice(0, 80)}"`
        );
      },
    });
  };
}

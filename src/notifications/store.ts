import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const OVERWATCH_DIR = join(homedir(), ".overwatch");
const NOTIFICATIONS_PATH = join(OVERWATCH_DIR, "notifications.json");
const MAX_NOTIFICATIONS = 500;

export type NotificationKind =
  | "scheduled_task_status"
  | "scheduled_task_result"
  | "scheduled_task_error"
  | "delegated_session_update"
  | "system_notice";

export type NotificationStatus = "new" | "seen" | "acknowledged";

export interface NotificationEvent {
  id: string;
  createdAt: string;
  kind: NotificationKind;
  title: string;
  body: string;
  speakableText?: string;
  status: NotificationStatus;
  source: {
    type: "scheduler" | "agent" | "system";
    id?: string;
  };
  metadata?: Record<string, unknown>;
}

type NotificationEvents = {
  created: [NotificationEvent];
  updated: [NotificationEvent];
};

class TypedEmitter extends EventEmitter {
  emit<K extends keyof NotificationEvents>(
    event: K,
    ...args: NotificationEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof NotificationEvents>(
    event: K,
    listener: (...args: NotificationEvents[K]) => void
  ): this {
    return super.on(event, listener);
  }

  off<K extends keyof NotificationEvents>(
    event: K,
    listener: (...args: NotificationEvents[K]) => void
  ): this {
    return super.off(event, listener);
  }
}

function ensureDir(): void {
  if (!existsSync(OVERWATCH_DIR)) {
    mkdirSync(OVERWATCH_DIR, { recursive: true });
  }
}

function loadAll(): NotificationEvent[] {
  ensureDir();
  if (!existsSync(NOTIFICATIONS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(NOTIFICATIONS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveAll(notifications: NotificationEvent[]): void {
  ensureDir();
  const trimmed = notifications.slice(-MAX_NOTIFICATIONS);
  writeFileSync(NOTIFICATIONS_PATH, JSON.stringify(trimmed, null, 2), "utf-8");
}

class NotificationStore {
  private readonly emitter = new TypedEmitter();

  list(limit = 100): NotificationEvent[] {
    return loadAll().slice(-limit).reverse();
  }

  create(input: Omit<NotificationEvent, "id" | "createdAt" | "status"> & { status?: NotificationStatus }): NotificationEvent {
    const notification: NotificationEvent = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: input.status ?? "new",
      ...input,
    };
    const notifications = loadAll();
    notifications.push(notification);
    saveAll(notifications);
    this.emitter.emit("created", notification);
    return notification;
  }

  acknowledge(id: string): NotificationEvent | null {
    const notifications = loadAll();
    const index = notifications.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const updated: NotificationEvent = {
      ...notifications[index],
      status: "acknowledged",
    };
    notifications[index] = updated;
    saveAll(notifications);
    this.emitter.emit("updated", updated);
    return updated;
  }

  subscribe(
    onCreated: (notification: NotificationEvent) => void,
    onUpdated?: (notification: NotificationEvent) => void
  ): () => void {
    this.emitter.on("created", onCreated);
    if (onUpdated) this.emitter.on("updated", onUpdated);
    return () => {
      this.emitter.off("created", onCreated);
      if (onUpdated) this.emitter.off("updated", onUpdated);
    };
  }
}

export const notificationStore = new NotificationStore();

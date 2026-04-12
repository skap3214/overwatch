import type { NotificationEvent } from "../notifications/store.js";
import type { ScheduledMonitor } from "../extensions/scheduler.js";

export interface RealtimeEnvelope<T = unknown> {
  id?: string;
  type: string;
  createdAt?: string;
  payload: T;
}

export type ClientEnvelope =
  | RealtimeEnvelope<{ clientName?: string; lastNotificationId?: string | null }>
  | RealtimeEnvelope<{ text: string }>
  | RealtimeEnvelope<{ notificationId: string }>;

export type ServerEnvelope =
  | RealtimeEnvelope<{ serverTime: string }>
  | RealtimeEnvelope<{ notifications: NotificationEvent[] }>
  | RealtimeEnvelope<{ monitors: ScheduledMonitor[] }>
  | RealtimeEnvelope<{ turnId: string; position: number }>
  | RealtimeEnvelope<{ turnId: string }>
  | RealtimeEnvelope<{ turnId: string; text: string }>
  | RealtimeEnvelope<{ turnId: string; name: string }>
  | RealtimeEnvelope<{ turnId: string; base64: string; mimeType: string }>
  | RealtimeEnvelope<{ turnId: string; message: string }>
  | RealtimeEnvelope<NotificationEvent>
  | RealtimeEnvelope<{ message: string }>;

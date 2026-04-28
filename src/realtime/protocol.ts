import type { NotificationEvent } from "../notifications/store.js";
import type { ScheduledMonitor } from "../extensions/scheduler.js";
import type {
  AgentProviderInfo,
  HarnessCapabilities,
} from "../harness/providers/types.js";

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

export interface ActiveSkill {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}

export interface HarnessSnapshotPayload {
  /** Active provider id. Same as `provider` (kept for clarity). */
  active: string;
  /** Full registry — lets the mobile app render a picker without hardcoding. */
  providers: AgentProviderInfo[];
  // Legacy fields, preserved so older clients keep working:
  provider: string;
  capabilities: HarnessCapabilities;
}

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
  | RealtimeEnvelope<{ skills: ActiveSkill[] }>
  | RealtimeEnvelope<HarnessSnapshotPayload>
  | RealtimeEnvelope<NotificationEvent>
  | RealtimeEnvelope<{ message: string }>;

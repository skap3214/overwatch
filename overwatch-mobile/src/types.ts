/**
 * Mobile-side types. The wire-protocol types (HarnessEvent, HarnessCommand,
 * Envelope, ServerMessage) are imported from `@overwatch/shared/protocol`,
 * codegenned from `/protocol/schema/`. This file holds only the local UI
 * concepts that don't belong to the wire protocol.
 */

/** Mobile UI turn-state machine for the PTT button affordances. */
export type TurnState =
  | "idle"
  | "preparing"
  | "recording"
  | "processing"
  | "playing";

export type MessageRole = "user" | "assistant" | "tool_call" | "error";

export type Message = {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: number;
  /** Reasoning trace from a reasoning-capable harness (Hermes). Rendered, never spoken. */
  reasoning?: string;
};

export type NotificationStatus = "new" | "seen" | "acknowledged";

export type NotificationKind =
  | "scheduled_task_status"
  | "scheduled_task_result"
  | "scheduled_task_error"
  | "delegated_session_update"
  | "system_notice";

export type NotificationEvent = {
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
};

export type ScheduledMonitor = {
  id: string;
  title: string;
  scheduleLabel: string;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  recurring: boolean;
  enabled?: boolean;
  state?: string;
  lastStatus?: "ok" | "error" | null;
  lastError?: string | null;
  paused?: boolean;
  repeat?: { times: number | null; completed: number } | null;
  source?: "local" | "hermes";
};

export type MonitorActionName =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "pause"
  | "resume"
  | "run_now"
  | "list_runs"
  | "read_run";

export type MonitorActionMetadata = {
  source: "local" | "hermes";
  provider_id: string;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_pause: boolean;
  can_resume: boolean;
  can_run_now: boolean;
  supports_run_history: boolean;
  unsupported_reason?: string;
};

export type ActiveSkill = {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  version?: string;
};

export type HarnessCapabilities = {
  hasNativeCron: boolean;
  hasNativeSkills: boolean;
  hasNativeMemory: boolean;
  hasSessionContinuity: boolean;
  emitsReasoning: boolean;
  voiceConvention: "soul-md" | "instructions-prefix" | "none";
};

export type AgentProviderInfo = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  capabilities: HarnessCapabilities;
  installed: boolean;
  installInstruction?: string;
};

export type HarnessSnapshot = {
  active: string;
  providers: AgentProviderInfo[];
  provider: string;
  capabilities: HarnessCapabilities;
};

export type JobRun = {
  id: string;
  jobId: string;
  ranAt: string;
  filename: string;
  outputPath: string;
};

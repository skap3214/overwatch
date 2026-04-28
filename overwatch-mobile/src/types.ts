export type TurnState = "idle" | "preparing" | "recording" | "processing" | "playing";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export type MessageRole = "user" | "assistant" | "tool_call" | "error";

export type Message = {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: number;
  /** Reasoning trace from a reasoning-capable harness (Hermes). Rendered, never spoken. */
  reasoning?: string;
};

export type SSEEvent =
  | { type: "text_delta"; data: { text: string } }
  | { type: "tool_call"; data: { name: string } }
  | {
      type: "audio_chunk";
      data: { base64: string; mimeType: string };
    }
  | { type: "tts_error"; data: { message: string } }
  | { type: "error"; data: { message: string } }
  | { type: "done"; data: Record<string, never> };

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
  // Hermes-source extensions (optional for back-compat)
  enabled?: boolean;
  state?: string;
  lastStatus?: "ok" | "error" | null;
  lastError?: string | null;
  paused?: boolean;
  repeat?: { times: number | null; completed: number } | null;
  source?: "local" | "hermes";
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
  // Legacy fields, kept so older snapshots still typecheck:
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

export type WsEnvelope<T = unknown> = {
  id: string;
  createdAt: string;
  type: string;
  payload: T;
};

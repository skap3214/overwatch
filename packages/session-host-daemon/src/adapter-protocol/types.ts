/**
 * Local types for the adapter-protocol server.
 * Consumes the codegenned wire-protocol types from @overwatch/shared/protocol.
 */

import type {
  Cancel,
  HarnessCommand,
  HarnessEvent,
  ManageMonitor,
  SubmitText,
  SubmitWithSteer,
} from "@overwatch/shared/protocol";

export type {
  HarnessCommand,
  HarnessEvent,
  SubmitText,
  SubmitWithSteer,
  Cancel,
  ManageMonitor,
};

export interface AdapterProtocolDeps {
  /** Relay URL the daemon connects to (e.g. https://overwatch-relay.soami.workers.dev). */
  relayUrl: string;
  /** User identity bootstrapped at QR-pair time. */
  userId: string;
  /** Long-term pairing token shared with phone + orchestrator. */
  pairingToken: string;
  /** Per-user secret used to verify orchestrator-signed per-session tokens. */
  sessionTokenSecret: string;
  /** Path to the JSONL audit log. */
  auditLogPath: string;
  /** When set, every wire event from each adapter is appended to a JSONL file. */
  catchAllLoggerEnabled: boolean;
}

export type CommandKind = HarnessCommand["kind"];

export const COMMAND_ALLOWLIST: ReadonlySet<CommandKind> = new Set<CommandKind>([
  "submit_text",
  "submit_with_steer",
  "cancel",
  "manage_monitor",
]);

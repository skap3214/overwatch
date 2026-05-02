/**
 * Append-only JSONL audit log of every cloud-originated command the daemon
 * receives. Useful for the user to verify what the cloud orchestrator did on
 * their behalf. 30-day rotation handled by daily file naming + a periodic
 * cleanup pass (not yet implemented — files don't grow large enough yet).
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HarnessCommand } from "@overwatch/shared/protocol";

export interface AuditEntry {
  timestamp: string;
  command_kind: HarnessCommand["kind"];
  correlation_id: string;
  target: string;
  /** Bytes in payload; we don't log full text to avoid leaking user prompts. */
  payload_size: number;
  session_id: string;
  outcome: "accepted" | "rejected";
  reason?: string;
}

export class AuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  append(command: HarnessCommand, session_id: string, outcome: AuditEntry["outcome"], reason?: string): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      command_kind: command.kind,
      correlation_id: command.correlation_id,
      target: command.target,
      payload_size: JSON.stringify(command.payload).length,
      session_id,
      outcome,
      reason,
    };
    try {
      appendFileSync(this.path, JSON.stringify(entry) + "\n");
    } catch {
      // Best effort — never fail a command because of audit log issues.
    }
  }
}

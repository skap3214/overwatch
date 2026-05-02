/**
 * Audit log writes a JSONL entry for every cloud-originated command.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/adapter-protocol/audit-log.js";
import type { HarnessCommand } from "@overwatch/shared/protocol";

function makeCmd(overrides: Partial<HarnessCommand> = {}): HarnessCommand {
  return {
    kind: "submit_text",
    correlation_id: "turn-1",
    target: "claude-code",
    payload: { text: "hello" },
    ...overrides,
  } as HarnessCommand;
}

test("audit-log: appends JSONL entry on accepted command", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  const path = join(dir, "audit.jsonl");
  const log = new AuditLog(path);
  log.append(makeCmd(), "session-1", "accepted");

  assert.ok(existsSync(path));
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.command_kind, "submit_text");
  assert.equal(entry.correlation_id, "turn-1");
  assert.equal(entry.session_id, "session-1");
  assert.equal(entry.outcome, "accepted");
});

test("audit-log: includes payload size, not raw payload (privacy)", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  const path = join(dir, "audit.jsonl");
  const log = new AuditLog(path);
  log.append(makeCmd({ payload: { text: "secret stuff" } }), "session-1", "accepted");

  const entry = JSON.parse(readFileSync(path, "utf-8").trim());
  assert.ok(typeof entry.payload_size === "number");
  assert.ok(entry.payload_size > 0);
  // Raw payload text MUST NOT appear in the audit log.
  assert.ok(!JSON.stringify(entry).includes("secret stuff"));
});

test("audit-log: appends multiple commands sequentially", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  const path = join(dir, "audit.jsonl");
  const log = new AuditLog(path);
  log.append(makeCmd({ correlation_id: "t1" }), "s", "accepted");
  log.append(makeCmd({ correlation_id: "t2" }), "s", "accepted");
  log.append(makeCmd({ correlation_id: "t3" }), "s", "rejected", "kind not allowlisted");

  const lines = readFileSync(path, "utf-8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[2]).outcome, "rejected");
  assert.equal(JSON.parse(lines[2]).reason, "kind not allowlisted");
});

test("audit-log: timestamps are valid ISO8601", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  const path = join(dir, "audit.jsonl");
  const log = new AuditLog(path);
  log.append(makeCmd(), "s", "accepted");

  const entry = JSON.parse(readFileSync(path, "utf-8").trim());
  const date = new Date(entry.timestamp);
  assert.ok(!Number.isNaN(date.getTime()));
});

test("audit-log: creates parent directory if missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  const nested = join(dir, "a", "b", "c", "audit.jsonl");
  // No throw on construction, even though the dir does not exist.
  const log = new AuditLog(nested);
  log.append(makeCmd(), "s", "accepted");
  assert.ok(existsSync(nested));
});

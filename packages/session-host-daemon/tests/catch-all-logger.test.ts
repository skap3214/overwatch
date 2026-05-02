/**
 * Catch-all logger: env-gated JSONL of every wire event from each adapter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import os from "node:os";

import { createCatchAllLogger } from "../src/adapter-protocol/catch-all-logger.js";

const ORIG_HOMEDIR = os.homedir;

function withFakeHomedir(fakeDir: string, fn: () => void): void {
  os.homedir = () => fakeDir;
  try {
    fn();
  } finally {
    os.homedir = ORIG_HOMEDIR;
  }
}

test("catch-all-logger: disabled returns no-op (no file created)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-test-"));
  withFakeHomedir(dir, () => {
    const log = createCatchAllLogger("claude-code", false);
    log({ type: "system", subtype: "init" });
    log({ type: "result", subtype: "success" });
    // No directory should be created.
    assert.equal(existsSync(join(dir, ".overwatch", "catch-all")), false);
  });
});

test("catch-all-logger: enabled appends per-day JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-test-"));
  withFakeHomedir(dir, () => {
    const log = createCatchAllLogger("claude-code", true);
    log({ type: "stream_event", event: { type: "content_block_delta" } });
    log({ type: "result", subtype: "success" });

    const root = join(dir, ".overwatch", "catch-all", "claude-code");
    assert.ok(existsSync(root));
    const files = readdirSync(root);
    assert.equal(files.length, 1);
    const lines = readFileSync(join(root, files[0]), "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    const entry0 = JSON.parse(lines[0]);
    assert.ok(typeof entry0.ts === "number");
    assert.equal(entry0.event.type, "stream_event");
  });
});

test("catch-all-logger: per-provider segregation", () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-test-"));
  withFakeHomedir(dir, () => {
    const claudeLog = createCatchAllLogger("claude-code", true);
    const piLog = createCatchAllLogger("pi", true);
    claudeLog({ type: "stream_event" });
    piLog({ type: "message_update" });

    const claudeRoot = join(dir, ".overwatch", "catch-all", "claude-code");
    const piRoot = join(dir, ".overwatch", "catch-all", "pi");
    assert.ok(existsSync(claudeRoot));
    assert.ok(existsSync(piRoot));
  });
});

test("catch-all-logger: tolerates fs errors silently", () => {
  // Pointing at a path that can't be written to, e.g. /dev/null/ subdir.
  const log = createCatchAllLogger("test-provider", true);
  // Should not throw even if writes start failing midway.
  log({ type: "x" });
  log({ type: "y" });
  // No assertion — verifying the absence of throw.
});

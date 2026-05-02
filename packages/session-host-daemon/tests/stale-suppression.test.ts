import { test } from "node:test";
import assert from "node:assert/strict";

import { StaleSuppression } from "../src/adapter-protocol/stale-suppression.js";

test("stale-suppression: marked ids are stale", () => {
  const ss = new StaleSuppression();
  ss.markCancelled("turn-1");
  assert.ok(ss.isStale("turn-1"));
  assert.equal(ss.isStale("turn-2"), false);
});

test("stale-suppression: ring buffer evicts oldest", () => {
  const ss = new StaleSuppression(2);
  ss.markCancelled("a");
  ss.markCancelled("b");
  ss.markCancelled("c");
  assert.equal(ss.isStale("a"), false); // evicted
  assert.ok(ss.isStale("b"));
  assert.ok(ss.isStale("c"));
});

test("stale-suppression: duplicate marks are idempotent", () => {
  const ss = new StaleSuppression(2);
  ss.markCancelled("a");
  ss.markCancelled("a");
  ss.markCancelled("b");
  assert.ok(ss.isStale("a"));
  assert.ok(ss.isStale("b"));
});

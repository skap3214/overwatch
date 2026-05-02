import { test } from "node:test";
import assert from "node:assert/strict";

import { CancellationRegistry } from "../src/adapter-protocol/cancellation.js";

test("cancellation: register + confirm resolves the promise", async () => {
  const reg = new CancellationRegistry(1000);
  const turn = reg.register("turn-1");
  assert.ok(turn.abortController);

  const cancelPromise = reg.cancel("turn-1");
  reg.confirmCancel("turn-1");
  await cancelPromise; // resolves
});

test("cancellation: timeout rejects when no confirmation", async () => {
  const reg = new CancellationRegistry(50);
  reg.register("turn-2");
  const cancelPromise = reg.cancel("turn-2");
  await assert.rejects(cancelPromise, /timeout/);
});

test("cancellation: cancel of unknown id resolves immediately", async () => {
  const reg = new CancellationRegistry(1000);
  await reg.cancel("never-registered"); // resolves
});

test("cancellation: register triggers abort signal on cancel", () => {
  const reg = new CancellationRegistry(1000);
  const turn = reg.register("turn-3");
  let aborted = false;
  turn.abortController.signal.addEventListener("abort", () => {
    aborted = true;
  });
  reg.cancel("turn-3");
  assert.ok(aborted);
});

test("cancellation: hasInflight tracks registrations", () => {
  const reg = new CancellationRegistry();
  assert.equal(reg.hasInflight(), false);
  reg.register("turn-a");
  assert.ok(reg.hasInflight());
  reg.unregister("turn-a");
  assert.equal(reg.hasInflight(), false);
});

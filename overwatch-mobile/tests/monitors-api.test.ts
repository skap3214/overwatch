import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleMonitorActionResult,
  monitorsApi,
  registerMonitorActionSender,
} from "../src/services/monitors-api.js";
import { useMonitorsStore } from "../src/stores/monitors-store.js";
import type { ScheduledMonitor } from "../src/types.js";

function monitor(id: string): ScheduledMonitor {
  return {
    id,
    title: `Monitor ${id}`,
    scheduleLabel: "Every hour",
    nextRunAt: null,
    lastFiredAt: null,
    recurring: true,
    source: "hermes",
  };
}

test("monitorsApi correlates action result by request id", async () => {
  registerMonitorActionSender(null);
  const sent: Array<{ request_id: string; action: string; monitor_id?: string }> = [];
  registerMonitorActionSender((payload) => {
    sent.push(payload);
    handleMonitorActionResult({
      type: "monitor_action_result",
      request_id: payload.request_id,
      ok: true,
      action: payload.action,
      monitors: [monitor("job-1")],
    });
  });

  await monitorsApi.run("job-1");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "run_now");
  assert.equal(sent[0].monitor_id, "job-1");
  assert.deepEqual(useMonitorsStore.getState().monitors.map((m) => m.id), ["job-1"]);
  registerMonitorActionSender(null);
});

test("monitorsApi rejects failed monitor action results", async () => {
  registerMonitorActionSender((payload) => {
    handleMonitorActionResult({
      type: "monitor_action_result",
      request_id: payload.request_id,
      ok: false,
      action: payload.action,
      error: { code: "monitor_action_failed", message: "Hermes refused the job" },
    });
  });

  await assert.rejects(monitorsApi.pause("job-2"), /Hermes refused the job/);
  registerMonitorActionSender(null);
});

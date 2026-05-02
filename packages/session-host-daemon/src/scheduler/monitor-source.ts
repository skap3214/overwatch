/**
 * MonitorSource — pluggable backend for the mobile monitor list.
 *
 * The Overwatch mobile app shows a "monitors" panel. The data behind it can
 * come from either:
 *   - the local scheduler (~/.overwatch/scheduled_tasks.json), via the
 *     existing scheduler.ts module
 *   - the Hermes gateway's /api/jobs, via HermesJobsBridge
 *
 * This interface lets the realtime server take a single MonitorSource and
 * stay agnostic about which one is plugged in.
 */

import type { ScheduledMonitor } from "../extensions/scheduler.js";

export interface MonitorSource {
  list(): Promise<ScheduledMonitor[]> | ScheduledMonitor[];
  subscribe(listener: (monitors: ScheduledMonitor[]) => void): () => void;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

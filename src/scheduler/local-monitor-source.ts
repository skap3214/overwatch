import {
  listScheduledMonitors,
  subscribeScheduledMonitors,
  type ScheduledMonitor,
} from "../extensions/scheduler.js";
import type { MonitorSource } from "./monitor-source.js";

export class LocalMonitorSource implements MonitorSource {
  list(): ScheduledMonitor[] {
    return listScheduledMonitors().map((m) => ({ ...m, source: "local" as const }));
  }

  subscribe(listener: (monitors: ScheduledMonitor[]) => void): () => void {
    return subscribeScheduledMonitors((monitors) => {
      listener(monitors.map((m) => ({ ...m, source: "local" as const })));
    });
  }
}

import { create } from "zustand";
import type { MonitorActionMetadata, ScheduledMonitor } from "../types";

const DEFAULT_ACTIONS: MonitorActionMetadata = {
  source: "local",
  provider_id: "pi-coding-agent",
  can_create: false,
  can_edit: false,
  can_delete: false,
  can_pause: false,
  can_resume: false,
  can_run_now: false,
  supports_run_history: false,
  unsupported_reason: "Monitor actions are unavailable until the daemon connects.",
};

type MonitorsStore = {
  monitors: ScheduledMonitor[];
  actions: MonitorActionMetadata;
  replaceMonitors: (
    monitors: ScheduledMonitor[],
    actions?: MonitorActionMetadata,
  ) => void;
  monitorCount: () => number;
};

function sortMonitors(monitors: ScheduledMonitor[]): ScheduledMonitor[] {
  return monitors
    .slice()
    .sort((a, b) => {
      if (!a.nextRunAt && !b.nextRunAt) return a.title.localeCompare(b.title);
      if (!a.nextRunAt) return 1;
      if (!b.nextRunAt) return -1;
      return a.nextRunAt.localeCompare(b.nextRunAt);
    });
}

export const useMonitorsStore = create<MonitorsStore>((set, get) => ({
  monitors: [],
  actions: DEFAULT_ACTIONS,

  replaceMonitors: (monitors, actions) => {
    set({ monitors: sortMonitors(monitors), actions: actions ?? get().actions });
  },

  monitorCount: () => get().monitors.length,
}));

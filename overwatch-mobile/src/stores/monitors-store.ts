import { create } from "zustand";
import type { ScheduledMonitor } from "../types";

type MonitorsStore = {
  monitors: ScheduledMonitor[];
  replaceMonitors: (monitors: ScheduledMonitor[]) => void;
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

  replaceMonitors: (monitors) => {
    set({ monitors: sortMonitors(monitors) });
  },

  monitorCount: () => get().monitors.length,
}));

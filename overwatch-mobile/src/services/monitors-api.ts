import { useMonitorsStore } from "../stores/monitors-store";
import type { JobRun, MonitorActionName, ScheduledMonitor } from "../types";

type MonitorActionPayload = {
  request_id: string;
  action: MonitorActionName;
  monitor_id?: string;
  run_id?: string;
  input?: Record<string, unknown>;
};

type MonitorActionResult = {
  type: "monitor_action_result";
  request_id: string;
  ok: boolean;
  action?: MonitorActionName;
  monitor?: ScheduledMonitor;
  monitors?: ScheduledMonitor[];
  runs?: JobRun[];
  content?: string;
  error?: { code: string; message: string };
};

type MonitorActionSender = (payload: MonitorActionPayload) => void;

const REQUEST_TIMEOUT_MS = 15000;
let actionSender: MonitorActionSender | null = null;
const pending = new Map<
  string,
  {
    resolve: (value: MonitorActionResult) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

export function registerMonitorActionSender(sender: MonitorActionSender | null): void {
  actionSender = sender;
}

export function handleMonitorActionResult(result: MonitorActionResult): void {
  const waiter = pending.get(result.request_id);
  if (!waiter) return;
  pending.delete(result.request_id);
  clearTimeout(waiter.timeout);
  if (!result.ok) {
    waiter.reject(new Error(result.error?.message ?? "Monitor action failed."));
    return;
  }
  if (result.monitors) {
    useMonitorsStore.getState().replaceMonitors(result.monitors);
  }
  waiter.resolve(result);
}

function request(
  action: MonitorActionName,
  input: Omit<MonitorActionPayload, "request_id" | "action"> = {},
): Promise<MonitorActionResult> {
  if (!actionSender) {
    return Promise.reject(new Error("Connect to Overwatch before managing monitors."));
  }
  const request_id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const payload: MonitorActionPayload = { request_id, action, ...input };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(request_id);
      reject(new Error("Monitor action timed out."));
    }, REQUEST_TIMEOUT_MS);
    pending.set(request_id, { resolve, reject, timeout });
    try {
      actionSender?.(payload);
    } catch (error) {
      pending.delete(request_id);
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export const monitorsApi = {
  async list(): Promise<ScheduledMonitor[]> {
    return useMonitorsStore.getState().monitors;
  },
  async get(_id: string): Promise<ScheduledMonitor | null> {
    return useMonitorsStore.getState().monitors.find((m) => m.id === _id) ?? null;
  },
  async create(input: {
    name: string;
    schedule: string;
    prompt: string;
  }): Promise<ScheduledMonitor> {
    const result = await request("create", {
      input: { title: input.name, name: input.name, schedule: input.schedule, prompt: input.prompt },
    });
    return result.monitor ?? result.monitors?.[0] ?? failMissingMonitor();
  },
  async update(
    id: string,
    input: { name?: string; schedule?: string; prompt?: string },
  ): Promise<ScheduledMonitor> {
    const result = await request("update", {
      monitor_id: id,
      input: { title: input.name, name: input.name, schedule: input.schedule, prompt: input.prompt },
    });
    return result.monitor ?? result.monitors?.find((m) => m.id === id) ?? failMissingMonitor();
  },
  async remove(id: string): Promise<void> {
    await request("delete", { monitor_id: id });
  },
  async pause(id: string): Promise<void> {
    await request("pause", { monitor_id: id });
  },
  async resume(id: string): Promise<void> {
    await request("resume", { monitor_id: id });
  },
  async run(id: string): Promise<void> {
    await request("run_now", { monitor_id: id });
  },
  async runs(id: string): Promise<JobRun[]> {
    return (await this.listRuns(id)).runs;
  },
  async runOutput(jobId: string, runId: string): Promise<string | null> {
    return (await this.readRun(jobId, runId)).content;
  },
  async listRuns(id: string): Promise<{ runs: JobRun[] }> {
    const result = await request("list_runs", { monitor_id: id });
    return { runs: result.runs ?? [] };
  },
  async readRun(
    jobId: string,
    runId: string,
  ): Promise<{ content: string }> {
    const result = await request("read_run", { monitor_id: jobId, run_id: runId });
    return { content: result.content ?? "" };
  },
};

function failMissingMonitor(): never {
  throw new Error("Monitor action succeeded but did not return a monitor.");
}

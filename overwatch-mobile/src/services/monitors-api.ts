/**
 * Monitor management API — POST-OVERHAUL STUB.
 *
 * In the legacy architecture, the phone reached the Mac daemon's
 * `/api/v1/monitors` REST endpoints over the same LAN. After the overhaul,
 * the phone speaks to Pipecat Cloud (audio + RTVI) and the daemon speaks to
 * the relay's UserChannel — there is no phone↔daemon HTTP path.
 *
 * Until we wire monitor management into the harness command surface (e.g.
 * a `manage_monitor` HarnessCommand kind, or surface monitors to the phone
 * via `provider_event { provider: "overwatch", kind: "monitor.snapshot" }`),
 * the mobile UI for creating/editing/pausing monitors is non-functional.
 *
 * This stub keeps the components compiling and surfaces a clear error to
 * the user rather than crashing on import.
 */

import type { ScheduledMonitor, JobRun } from "../types";

const NOT_WIRED =
  "Monitor management from mobile is not yet wired in the new architecture. " +
  "Manage monitors via voice or `overwatch` CLI on the host machine.";

export const monitorsApi = {
  async list(): Promise<ScheduledMonitor[]> {
    return [];
  },
  async get(_id: string): Promise<ScheduledMonitor | null> {
    return null;
  },
  async create(_input: {
    name: string;
    schedule: string;
    prompt: string;
  }): Promise<ScheduledMonitor> {
    throw new Error(NOT_WIRED);
  },
  async update(
    _id: string,
    _input: { name?: string; schedule?: string; prompt?: string },
  ): Promise<ScheduledMonitor> {
    throw new Error(NOT_WIRED);
  },
  async remove(_id: string): Promise<void> {
    throw new Error(NOT_WIRED);
  },
  async pause(_id: string): Promise<void> {
    throw new Error(NOT_WIRED);
  },
  async resume(_id: string): Promise<void> {
    throw new Error(NOT_WIRED);
  },
  async run(_id: string): Promise<void> {
    throw new Error(NOT_WIRED);
  },
  async runs(_id: string): Promise<JobRun[]> {
    return [];
  },
  async runOutput(_jobId: string, _runId: string): Promise<string | null> {
    return null;
  },
  async listRuns(_id: string): Promise<{ runs: JobRun[] }> {
    return { runs: [] };
  },
  async readRun(
    _jobId: string,
    _runId: string,
  ): Promise<{ content: string }> {
    return { content: "" };
  },
};

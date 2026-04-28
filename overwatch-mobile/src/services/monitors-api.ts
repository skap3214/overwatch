/**
 * Thin wrappers around the backend's /api/v1/monitors/* REST shim.
 * Works in both local mode (proxies to scheduler.ts) and Hermes mode
 * (proxies to /api/jobs).
 */

import { useConnectionStore } from "../stores/connection-store";
import type { JobRun, ScheduledMonitor } from "../types";

function backendBase(): string {
  const url = useConnectionStore.getState().backendURL;
  if (!url) throw new Error("No backend URL configured");
  if (url.startsWith("relay:")) {
    throw new Error("Monitor API not available in relay mode");
  }
  return url.replace(/\/+$/, "");
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${backendBase()}/api/v1/monitors${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text };
  }
  if (!res.ok) {
    const err = parsed as { error?: string };
    throw new Error(err.error ?? `${method} ${path} ${res.status}`);
  }
  return parsed as T;
}

export interface CreateMonitorBody {
  name: string;
  schedule: string;
  prompt: string;
  description?: string;
  recurring?: boolean;
  skills?: string[];
  deliver?: string;
  repeat?: number | null;
}

export interface UpdateMonitorBody {
  name?: string;
  schedule?: string;
  prompt?: string;
  deliver?: string;
  skills?: string[];
  repeat?: number | null;
  enabled?: boolean;
}

export const monitorsApi = {
  list: () => request<{ monitors: ScheduledMonitor[] }>("GET", "/"),
  get: (id: string) =>
    request<{ job: Record<string, unknown> }>("GET", `/${encodeURIComponent(id)}`),
  create: (body: CreateMonitorBody) => request("POST", "/", body),
  update: (id: string, body: UpdateMonitorBody) =>
    request("PATCH", `/${encodeURIComponent(id)}`, body),
  remove: (id: string) =>
    request<{ ok: boolean }>("DELETE", `/${encodeURIComponent(id)}`),
  pause: (id: string) =>
    request<{ job: Record<string, unknown> }>("POST", `/${encodeURIComponent(id)}/pause`),
  resume: (id: string) =>
    request<{ job: Record<string, unknown> }>("POST", `/${encodeURIComponent(id)}/resume`),
  run: (id: string) =>
    request<{ job: Record<string, unknown> }>("POST", `/${encodeURIComponent(id)}/run`),
  listRuns: (id: string) =>
    request<{ runs: JobRun[] }>("GET", `/${encodeURIComponent(id)}/runs`),
  readRun: (id: string, runId: string) =>
    request<{ runId: string; jobId: string; content: string; summary: string }>(
      "GET",
      `/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
    ),
};

/**
 * Read past Hermes cron job run outputs from the filesystem.
 *
 * Hermes does not expose a run-history endpoint. Outputs are written to
 *   ~/.hermes/cron/output/{job_id}/{YYYY-MM-DD_HH-MM-SS}.md
 * one file per run, 0700-permissioned. Overwatch backend runs as the same
 * user, so direct reads work.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface JobRun {
  id: string;
  jobId: string;
  ranAt: string; // ISO
  filename: string;
  outputPath: string;
}

const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.md$/;

function parseTimestamp(filename: string): string | null {
  const match = filename.match(FILENAME_RE);
  if (!match) return null;
  const [, date, time] = match;
  // YYYY-MM-DD_HH-MM-SS → YYYY-MM-DDTHH:MM:SS (local time, no TZ info available)
  const isoLike = `${date}T${time!.replace(/-/g, ":")}`;
  const d = new Date(isoLike);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function jobOutputDir(jobId: string): string {
  return path.join(os.homedir(), ".hermes", "cron", "output", jobId);
}

export async function listJobRuns(jobId: string): Promise<JobRun[]> {
  const dir = jobOutputDir(jobId);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const runs = files
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const ts = parseTimestamp(f);
      if (!ts) return null;
      return {
        id: f.replace(/\.md$/, ""),
        jobId,
        ranAt: ts,
        filename: f,
        outputPath: path.join(dir, f),
      } satisfies JobRun;
    })
    .filter((r): r is JobRun => r !== null)
    .sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1));
  return runs;
}

export async function readJobRunOutput(
  jobId: string,
  runId: string,
): Promise<string | null> {
  const dir = jobOutputDir(jobId);
  // Defend against path traversal: runId must match the timestamp regex.
  if (!FILENAME_RE.test(`${runId}.md`)) return null;
  const file = path.join(dir, `${runId}.md`);
  // Final containment check
  if (!file.startsWith(dir + path.sep)) return null;
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Summarize a run output for use in a notification body.
 * Heuristic: first non-empty line, truncated to 240 chars.
 */
export function summarizeOutput(markdown: string, maxChars = 240): string {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed.length > maxChars
        ? trimmed.slice(0, maxChars - 1) + "…"
        : trimmed;
    }
  }
  return markdown.slice(0, maxChars);
}

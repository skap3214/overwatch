/**
 * Minimal wrapper around the `tmux` CLI for the HTTP routes. We shell out via
 * execFile (no shell) so caller-supplied
 * strings are safely passed as separate argv entries — protects against
 * injection in `keys` and similar fields.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

interface ExecResult {
  stdout: string;
  stderr: string;
}

async function runTmux(args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  const { stdout, stderr } = await execFileP("tmux", args, {
    timeout: opts.timeoutMs ?? 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

export interface TmuxSessionSummary {
  name: string;
  windows: number;
  attached: boolean;
  created: string;
}

export interface TmuxPaneSummary {
  paneId: string;
  windowName: string;
  windowIndex: number;
  paneIndex: number;
  command: string;
  active: boolean;
}

export async function listSessions(): Promise<TmuxSessionSummary[]> {
  try {
    const { stdout } = await runTmux([
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}",
    ]);
    return stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const [name, windows, attached, created] = line.split("\t");
        return {
          name: name ?? "",
          windows: parseInt(windows ?? "0", 10),
          attached: attached === "1",
          created: created ?? "",
        };
      });
  } catch (err) {
    if (isNoServer(err)) return [];
    throw err;
  }
}

export async function listPanes(session: string): Promise<TmuxPaneSummary[]> {
  // -t accepts session name; -a flag would list all servers.
  const { stdout } = await runTmux([
    "list-panes",
    "-t",
    session,
    "-s",
    "-F",
    "#{pane_id}\t#{window_name}\t#{window_index}\t#{pane_index}\t#{pane_current_command}\t#{pane_active}",
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [paneId, windowName, windowIndex, paneIndex, command, active] = line.split("\t");
      return {
        paneId: paneId ?? "",
        windowName: windowName ?? "",
        windowIndex: parseInt(windowIndex ?? "0", 10),
        paneIndex: parseInt(paneIndex ?? "0", 10),
        command: command ?? "",
        active: active === "1",
      };
    });
}

export async function readPane(target: string, lines = 200): Promise<string> {
  const { stdout } = await runTmux([
    "capture-pane",
    "-t",
    target,
    "-p",
    "-S",
    `-${Math.max(1, Math.min(lines, 5000))}`,
  ]);
  return stdout;
}

/**
 * Send keys to a tmux target. We allow either:
 *   - "literal" mode: keys is treated as a string typed verbatim (use this for
 *     prompts going into Codex/Cursor as the SOUL.md tmux quirk recommends).
 *   - "keys" mode: keys is a tmux key spec (e.g. "Enter", "C-c", "Up").
 *
 * The `submit` flag, if true, sends a separate `Enter` after the literal text.
 */
export async function sendKeys(opts: {
  target: string;
  keys: string;
  literal?: boolean;
  submit?: boolean;
}): Promise<void> {
  const args = ["send-keys", "-t", opts.target];
  if (opts.literal) args.push("-l");
  args.push(opts.keys);
  await runTmux(args);
  if (opts.submit) {
    await runTmux(["send-keys", "-t", opts.target, "Enter"]);
  }
}

export async function newSession(name: string, command?: string): Promise<TmuxSessionSummary> {
  const args = ["new-session", "-d", "-s", name];
  if (command) args.push(command);
  await runTmux(args);
  const sessions = await listSessions();
  const created = sessions.find((s) => s.name === name);
  if (!created) throw new Error(`Failed to create session ${name}`);
  return created;
}

export async function killPane(paneId: string): Promise<void> {
  await runTmux(["kill-pane", "-t", paneId]);
}

export async function killSession(name: string): Promise<void> {
  await runTmux(["kill-session", "-t", name]);
}

function isNoServer(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const stderr = (err as { stderr?: string }).stderr ?? "";
  return /no server running/i.test(stderr);
}

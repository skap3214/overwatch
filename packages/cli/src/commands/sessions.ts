import { execSync } from "node:child_process";
import chalk from "chalk";

interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  created: string;
}

function listTmuxSessions(): TmuxSession[] {
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}|#{session_created}"',
      { encoding: "utf-8" }
    ).trim();

    if (!output) return [];

    return output.split("\n").map((line) => {
      const [name, windows, attached, created] = line.split("|");
      return {
        name,
        windows: parseInt(windows, 10),
        attached: attached === "1",
        created: new Date(parseInt(created, 10) * 1000).toLocaleTimeString(),
      };
    });
  } catch {
    return [];
  }
}

export async function sessionsCommand(): Promise<void> {
  const sessions = listTmuxSessions();

  if (sessions.length === 0) {
    console.log("");
    console.log(chalk.dim("  No tmux sessions found."));
    console.log("");
    return;
  }

  console.log("");
  for (const session of sessions) {
    const status = session.attached ? chalk.green("attached") : chalk.dim("detached");
    const windows = `${session.windows} window${session.windows !== 1 ? "s" : ""}`;
    console.log(`  ${chalk.bold(session.name.padEnd(20))} ${windows.padEnd(12)} ${status}`);
  }
  console.log("");
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config.js";

function getAgentConfigured(): boolean {
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  if (!existsSync(authPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    return Object.values(raw).some(
      (value) => Boolean(value) && Object.keys(value).length > 0
    );
  } catch {
    return false;
  }
}

function hasTmuxAutoStartConfigured(): boolean {
  const home = homedir();
  if (
    existsSync("/Applications/cmux.app") ||
    existsSync(join(home, "Library", "Application Support", "cmux"))
  ) {
    return true;
  }
  const rcFiles = [
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".zprofile"),
  ];
  for (const rcFile of rcFiles) {
    if (!existsSync(rcFile)) continue;
    const content = readFileSync(rcFile, "utf-8");
    if (/^\s*(exec\s+)?tmux\b|tmux\s+new-session|tmux\s+attach/m.test(content)) {
      return true;
    }
  }

  const termConfigs = [
    join(home, ".config", "ghostty", "config"),
    join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"),
    join(home, ".config", "kitty", "kitty.conf"),
    join(home, ".config", "alacritty", "alacritty.toml"),
  ];
  for (const configPath of termConfigs) {
    if (!existsSync(configPath)) continue;
    const content = readFileSync(configPath, "utf-8");
    if (
      content.includes("tmux") &&
      (content.includes("command") || content.includes("shell"))
    ) {
      return true;
    }
  }

  return false;
}

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const port = config.backendPort ?? 8787;
  const agentConfigured = getAgentConfigured();
  const terminalConfigured = hasTmuxAutoStartConfigured();

  let backendOk = false;
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    backendOk = res.ok;
  } catch {
    // not running
  }

  console.log("");
  console.log(
    `  Backend:  ${backendOk ? chalk.green("running") : chalk.red("not running")} (localhost:${port})`
  );
  console.log(`  Relay:    ${chalk.dim(config.relayUrl ?? "not configured")}`);
  console.log(
    `  Agent:    ${agentConfigured ? chalk.green("configured") : chalk.red("not set")}`
  );
  console.log(`  Deepgram: ${config.deepgramApiKey ? chalk.green("configured") : chalk.red("not set")} (STT + TTS)`);
  console.log(
    `  Terminal: ${terminalConfigured ? chalk.green("configured") : chalk.red("not set")} (tmux auto-start)`
  );
  console.log("");
}

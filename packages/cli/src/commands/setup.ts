import { createInterface } from "node:readline";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import chalk from "chalk";
import prompts from "prompts";
import { loadConfig, saveConfig, getConfigDir } from "../config.js";

function ask(
  rl: ReturnType<typeof createInterface>,
  question: string
): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// --- AI agent login via SDK ---

async function loginWithSDK(rl: ReturnType<typeof createInterface>): Promise<void> {
  const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
  const { execSync } = await import("node:child_process");
  const auth = AuthStorage.create();
  const providers = auth.getOAuthProviders();

  const response = await prompts({
    type: "select",
    name: "provider",
    message: "Select a provider to login",
    choices: providers.map((p: { id: string; name: string }) => ({
      title: auth.hasAuth(p.id) ? `${p.name} ${chalk.green("✓ logged in")}` : p.name,
      value: p.id,
    })),
  });

  if (!response.provider) {
    console.log(chalk.dim("  Skipped — you can run `overwatch setup` later to configure.\n"));
    return;
  }

  console.log("");

  try {
    await auth.login(response.provider, {
      onAuth: (info: { url: string; instructions?: string }) => {
        console.log(chalk.dim("  Opening browser for authentication..."));
        if (info.instructions) console.log(chalk.dim(`  ${info.instructions}`));
        try { execSync(`open "${info.url}"`); } catch {
          console.log(`  Open this URL: ${info.url}`);
        }
      },
      onPrompt: async (prompt: { message: string }) => {
        return await ask(rl, `  ${prompt.message} `);
      },
      onProgress: (message: string) => {
        console.log(chalk.dim(`  ${message}`));
      },
    });
    console.log(chalk.green("\n  ✓") + " Authenticated successfully\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Authentication failed";
    console.log(chalk.yellow("\n  !") + ` ${msg}\n`);
  }
}

// --- Terminal detection and configuration ---

interface TerminalInfo {
  name: string;
  configPath: string;
  detected: boolean;
}

function detectTerminals(): TerminalInfo[] {
  const home = homedir();
  const terminals: TerminalInfo[] = [
    {
      name: "Ghostty",
      configPath: existsSync(join(home, ".config", "ghostty", "config"))
        ? join(home, ".config", "ghostty", "config")
        : existsSync(join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"))
          ? join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config")
          : join(home, ".config", "ghostty", "config"), // default path if no config file yet
      detected:
        existsSync(join(home, ".config", "ghostty", "config")) ||
        existsSync(join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config")) ||
        existsSync("/Applications/Ghostty.app"),
    },
    {
      name: "Kitty",
      configPath: join(home, ".config", "kitty", "kitty.conf"),
      detected: existsSync(join(home, ".config", "kitty", "kitty.conf")),
    },
    {
      name: "iTerm2",
      configPath: join(
        home,
        "Library",
        "Preferences",
        "com.googlecode.iterm2.plist"
      ),
      detected: existsSync(
        join(home, "Library", "Preferences", "com.googlecode.iterm2.plist")
      ),
    },
    {
      name: "Alacritty",
      configPath: join(home, ".config", "alacritty", "alacritty.toml"),
      detected:
        existsSync(join(home, ".config", "alacritty", "alacritty.toml")) ||
        existsSync("/Applications/Alacritty.app"),
    },
    {
      name: "cmux",
      configPath: join(home, "Library", "Application Support", "cmux"),
      detected:
        existsSync("/Applications/cmux.app") ||
        existsSync(join(home, "Library", "Application Support", "cmux")),
    },
  ];
  return terminals;
}

const TMUX_SCRIPT = `#!/bin/bash
# overwatch: auto-start tmux session on new terminal tab
# Don't nest — if already inside tmux, just start a shell
[ -n "\$TMUX" ] && exec "\${SHELL:-/bin/zsh}"
# Ensure brew binaries are on PATH
if command -v brew &>/dev/null; then
  eval "\$(brew shellenv)"
elif [ -d "/opt/homebrew" ]; then
  eval "\$(/opt/homebrew/bin/brew shellenv)"
elif [ -d "/usr/local/Homebrew" ]; then
  eval "\$(/usr/local/bin/brew shellenv)"
fi
# Fall back to a normal shell if tmux isn't installed
if ! command -v tmux &>/dev/null; then
  exec "\${SHELL:-/bin/zsh}"
fi
n=0
while tmux has-session -t "ow-\$n" 2>/dev/null; do
  n=$((n + 1))
done
exec tmux new-session -s "ow-\$n"
`;

function installTmuxScript(): string {
  const scriptPath = join(getConfigDir(), "tmux-session.sh");
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(scriptPath, TMUX_SCRIPT, "utf-8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function backupFile(path: string): string {
  const backup = path + ".overwatch-backup";
  if (!existsSync(backup) && existsSync(path)) {
    copyFileSync(path, backup);
  }
  return backup;
}

function configureGhostty(configPath: string, scriptPath: string): boolean {
  // Ensure config directory exists
  const configDir = configPath.substring(0, configPath.lastIndexOf("/"));
  mkdirSync(configDir, { recursive: true });

  const content = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";

  if (content.includes("overwatch/tmux-session.sh")) {
    return false; // Already configured
  }

  // Check if there's an existing command line
  if (content.match(/^command\s*=/m)) {
    // Comment out the existing one
    const updated = content.replace(
      /^(command\s*=.*)$/m,
      `# $1  # commented by overwatch\ncommand = ${scriptPath}`
    );
    backupFile(configPath);
    writeFileSync(configPath, updated, "utf-8");
  } else {
    backupFile(configPath);
    const line = `\n# Added by overwatch — auto-start tmux on new tab\ncommand = ${scriptPath}\n`;
    writeFileSync(configPath, content + line, "utf-8");
  }
  return true;
}

function configureKitty(configPath: string, scriptPath: string): boolean {
  const content = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";

  if (content.includes("overwatch/tmux-session.sh")) {
    return false;
  }

  backupFile(configPath);
  const line = `\n# Added by overwatch — auto-start tmux on new tab\nshell ${scriptPath}\n`;
  writeFileSync(configPath, content + line, "utf-8");
  return true;
}

function configureAlacritty(configPath: string, scriptPath: string): boolean {
  const configDir = configPath.substring(0, configPath.lastIndexOf("/"));
  mkdirSync(configDir, { recursive: true });

  const content = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";

  if (content.includes("overwatch/tmux-session.sh")) {
    return false;
  }

  backupFile(configPath);

  // Migrate deprecated [shell] to [terminal.shell] if present
  if (content.includes("[terminal.shell]")) {
    const updated = content.replace(
      /\[terminal\.shell\]\s*\nprogram\s*=.*/,
      `[terminal.shell]\nprogram = "${scriptPath}"`
    );
    writeFileSync(configPath, updated, "utf-8");
  } else if (content.includes("[shell]")) {
    // Legacy format — update to new format
    const updated = content.replace(
      /\[shell\]\s*\nprogram\s*=.*/,
      `[terminal.shell]\nprogram = "${scriptPath}"`
    );
    writeFileSync(configPath, updated, "utf-8");
  } else {
    const line = `\n# Added by overwatch — auto-start tmux on new tab\n[terminal.shell]\nprogram = "${scriptPath}"\n`;
    writeFileSync(configPath, content + line, "utf-8");
  }
  return true;
}

function configureITerm2(scriptPath: string): boolean {
  // iTerm2 uses a plist — modify the default profile with PlistBuddy
  const plistPath = join(homedir(), "Library", "Preferences", "com.googlecode.iterm2.plist");
  if (!existsSync(plistPath)) return false;

  // Check if already configured
  try {
    const current = execSync(
      `/usr/libexec/PlistBuddy -c "Print :New\\ Bookmarks:0:Command" "${plistPath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (current.includes("overwatch/tmux-session.sh")) return false;
  } catch {
    // Field doesn't exist or is empty — proceed with configuration
  }

  // Set custom command on the default profile (index 0)
  try {
    execSync(
      `/usr/libexec/PlistBuddy -c "Set :New\\ Bookmarks:0:Custom\\ Command Yes" "${plistPath}"`,
      { stdio: "ignore" }
    );
    execSync(
      `/usr/libexec/PlistBuddy -c "Set :New\\ Bookmarks:0:Command ${scriptPath}" "${plistPath}"`,
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

function userHasCmux(): boolean {
  return existsSync("/Applications/cmux.app") ||
    existsSync(join(homedir(), "Library", "Application Support", "cmux"));
}

function userAlreadyHasTmux(): boolean {
  const home = homedir();

  // Check shell rc files for tmux auto-start
  const rcFiles = [
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".zprofile"),
  ];
  for (const rc of rcFiles) {
    if (!existsSync(rc)) continue;
    const content = readFileSync(rc, "utf-8");
    // Look for tmux exec/attach patterns (not just any mention of tmux)
    if (/^\s*(exec\s+)?tmux\b|tmux\s+new-session|tmux\s+attach/m.test(content)) {
      return true;
    }
  }

  // Check terminal configs
  const termConfigs = [
    join(home, ".config", "ghostty", "config"),
    join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"),
    join(home, ".config", "kitty", "kitty.conf"),
    join(home, ".config", "alacritty", "alacritty.toml"),
  ];
  for (const cfg of termConfigs) {
    if (!existsSync(cfg)) continue;
    const content = readFileSync(cfg, "utf-8");
    if (content.includes("tmux") && (content.includes("command") || content.includes("shell"))) {
      return true;
    }
  }
  return false;
}

function configureTerminalByName(name: string, configPath: string, scriptPath: string): boolean {
  switch (name) {
    case "Ghostty": return configureGhostty(configPath, scriptPath);
    case "Kitty": return configureKitty(configPath, scriptPath);
    case "Alacritty": return configureAlacritty(configPath, scriptPath);
    case "iTerm2": return configureITerm2(scriptPath);
    default: return false;
  }
}

// Get brew prefix reliably (works on Apple Silicon, Intel, and Linux)
function brewPrefix(): string {
  try {
    return execSync("brew --prefix", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    // Common defaults
    if (existsSync("/opt/homebrew")) return "/opt/homebrew";
    if (existsSync("/usr/local/Homebrew")) return "/usr/local";
    return "/usr/local";
  }
}

function shellPath(): string {
  const prefix = brewPrefix();
  return `${prefix}/bin:${process.env.PATH}`;
}

function isTmuxInstalled(): boolean {
  try {
    execSync("which tmux", { stdio: "pipe", env: { ...process.env, PATH: shellPath() } });
    return true;
  } catch {
    return false;
  }
}

async function setupTerminal(): Promise<void> {
  console.log(chalk.bold("\nTerminal Setup"));
  console.log(chalk.dim("──────────────"));

  if (userHasCmux()) {
    console.log(chalk.green("  ✓") + " cmux detected — built-in multiplexing, no tmux setup needed.");
    console.log(chalk.dim("  Overwatch will use tmux sessions alongside cmux.\n"));
  }

  // Install tmux if needed
  if (!isTmuxInstalled()) {
    console.log(chalk.yellow("  !") + " tmux is not installed. Installing...");
    try {
      execSync("brew install tmux", {
        stdio: "inherit",
        env: { ...process.env, PATH: shellPath() },
      });
      console.log(chalk.green("  ✓") + " tmux installed\n");
    } catch {
      console.log(chalk.red("  ✗") + " Failed to install tmux. Install manually: brew install tmux\n");
      return;
    }
  }

  console.log(
    chalk.dim("  Configure your terminal to auto-start tmux on new tabs.")
  );
  console.log(
    chalk.dim("  This lets Overwatch discover and control your sessions.\n")
  );

  const terminals = detectTerminals();
  const configurable = terminals.filter((t) => t.detected && t.name !== "cmux");

  if (configurable.length === 0) {
    console.log(
      chalk.yellow("  !") +
        " No supported terminals detected (Ghostty, Kitty, iTerm2, Alacritty)"
    );
    console.log(chalk.dim("  You can configure tmux manually later.\n"));
    return;
  }

  // Check which terminals already have tmux configured
  const needsConfig = configurable.filter((t) => {
    if (!existsSync(t.configPath)) return true;
    const content = readFileSync(t.configPath, "utf-8");
    return !content.includes("tmux");
  });
  // iTerm2 doesn't have a simple text config — always show it
  const iterm = configurable.find((t) => t.name === "iTerm2");
  if (iterm && !needsConfig.includes(iterm)) {
    // Check iTerm2 via PlistBuddy
    try {
      const cmd = execSync(
        `/usr/libexec/PlistBuddy -c "Print :New\\ Bookmarks:0:Command" "${iterm.configPath}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      if (!cmd.includes("tmux")) needsConfig.push(iterm);
    } catch {
      needsConfig.push(iterm);
    }
  }

  if (needsConfig.length === 0) {
    console.log(chalk.green("  ✓") + " All detected terminals already have tmux configured.\n");
    return;
  }

  // Show already-configured terminals
  const alreadyDone = configurable.filter((t) => !needsConfig.includes(t));
  for (const t of alreadyDone) {
    console.log(chalk.green("  ✓") + chalk.dim(` ${t.name} — already configured`));
  }

  const response = await prompts({
    type: "multiselect",
    name: "terminals",
    message: "Select terminals to configure",
    choices: needsConfig.map((t) => ({
      title: t.name,
      value: t.name,
      selected: true,
    })),
    hint: "Space to toggle, Enter to confirm",
  });

  if (!response.terminals || response.terminals.length === 0) {
    console.log(chalk.dim("  No terminals selected — skipping.\n"));
    return;
  }

  const scriptPath = installTmuxScript();

  for (const name of response.terminals as string[]) {
    const terminal = configurable.find((t) => t.name === name);
    if (!terminal) continue;

    const configured = configureTerminalByName(terminal.name, terminal.configPath, scriptPath);
    if (configured) {
      console.log(chalk.green("  ✓") + ` Configured ${terminal.name}`);
      if (terminal.name !== "iTerm2") {
        console.log(chalk.dim(`    Backup at ${terminal.configPath}.overwatch-backup`));
      }
    } else {
      console.log(chalk.dim(`  ${terminal.name} already configured`));
    }
  }

  console.log(chalk.bold("\n  Restart your terminal(s) for tmux auto-start to take effect."));
  console.log(chalk.dim("  New tabs will automatically open a tmux session.\n"));
}

// --- Main setup command ---

interface SetupOptions {
  deepgramKey?: string;
  configureTerminal?: string;
  nonInteractive?: boolean;
}

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  let rl = createInterface({ input: process.stdin, output: process.stdout });
  const config = loadConfig();
  const ni = options.nonInteractive ?? false;

  console.log("");
  console.log(chalk.bold("Overwatch Setup"));
  console.log(chalk.dim("───────────────"));
  console.log("");

  // Check pi-coding-agent setup
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  let agentConfigured = false;
  if (existsSync(authPath)) {
    try {
      const authData = JSON.parse(readFileSync(authPath, "utf-8"));
      // Check if any provider has credentials
      agentConfigured = Object.keys(authData).length > 0 &&
        Object.values(authData).some((v: any) => v && typeof v === "object" && Object.keys(v).length > 0);
    } catch {}
  }

  if (agentConfigured) {
    console.log(chalk.green("✓") + " AI agent configured");
    if (!ni) {
      const reconfigure = await ask(rl, `  Reconfigure? (y/N): `);
      if (reconfigure.trim().toLowerCase() === "y") {
        agentConfigured = false;
      }
    }
  }

  if (!agentConfigured) {
    if (ni) {
      console.log(chalk.yellow("!") + " AI agent not configured — run `overwatch setup` interactively or `pi` to set up.");
    } else {
      await loginWithSDK(rl);
      // Recreate readline — prompts library disrupts the original one
      rl.close();
      rl = createInterface({ input: process.stdin, output: process.stdout });
    }
  }
  console.log("");

  // Deepgram
  if (options.deepgramKey) {
    config.deepgramApiKey = options.deepgramKey;
    console.log(chalk.green("✓") + " Deepgram API key set for STT + TTS");
  } else if (!ni) {
    const deepgram = await ask(
      rl,
      `Deepgram API key (used for STT + TTS)${config.deepgramApiKey ? chalk.dim(" (enter to keep current)") : ""}: `
    );
    if (deepgram.trim()) config.deepgramApiKey = deepgram.trim();
  }

  saveConfig(config);
  console.log("");
  console.log(
    chalk.green("✓") + ` Config saved to ${getConfigDir()}/config.json`
  );

  // Always write latest tmux-session.sh (updates existing installs)
  installTmuxScript();

  // Terminal setup
  if (options.configureTerminal) {
    // Non-interactive terminal config
    const scriptPath = installTmuxScript();
    const name = options.configureTerminal.toLowerCase();
    const terminals = detectTerminals();
    const terminal = terminals.find((t) => t.name.toLowerCase() === name);
    if (terminal) {
      let configured = false;
      switch (terminal.name) {
        case "Ghostty": configured = configureGhostty(terminal.configPath, scriptPath); break;
        case "Kitty": configured = configureKitty(terminal.configPath, scriptPath); break;
        case "Alacritty": configured = configureAlacritty(terminal.configPath, scriptPath); break;
        case "iTerm2": configured = configureITerm2(scriptPath); break;
      }
      console.log(configured
        ? chalk.green("✓") + ` Configured ${terminal.name}`
        : chalk.dim(`  ${terminal.name} already configured`)
      );
    } else {
      console.log(chalk.yellow("!") + ` Terminal "${options.configureTerminal}" not found`);
    }
  } else if (!ni) {
    await setupTerminal();
  }

  rl.close();

  console.log(`Run ${chalk.bold("overwatch start")} to begin.`);
}

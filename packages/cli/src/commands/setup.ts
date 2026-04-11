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
import chalk from "chalk";
import { loadConfig, saveConfig, getConfigDir } from "../config.js";

function ask(
  rl: ReturnType<typeof createInterface>,
  question: string
): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function choose(
  rl: ReturnType<typeof createInterface>,
  question: string,
  options: string[]
): Promise<number> {
  console.log(question);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
  const answer = await ask(rl, `  Choice (1-${options.length}): `);
  const n = parseInt(answer.trim(), 10);
  if (n >= 1 && n <= options.length) return n - 1;
  return -1;
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
      detected: existsSync(
        join(home, ".config", "alacritty", "alacritty.toml")
      ),
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
TMUX_BIN="\${TMUX_BIN:-tmux}"
n=0
while \$TMUX_BIN has-session -t "\$n" 2>/dev/null; do
  n=$((n + 1))
done
exec \$TMUX_BIN new-session -s "\$n"
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
  const content = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";

  if (content.includes("overwatch/tmux-session.sh")) {
    return false;
  }

  backupFile(configPath);

  if (content.includes("[shell]")) {
    // Replace existing shell section
    const updated = content.replace(
      /\[shell\]\s*\nprogram\s*=.*/,
      `[shell]\nprogram = "${scriptPath}"`
    );
    writeFileSync(configPath, updated, "utf-8");
  } else {
    const line = `\n# Added by overwatch — auto-start tmux on new tab\n[shell]\nprogram = "${scriptPath}"\n`;
    writeFileSync(configPath, content + line, "utf-8");
  }
  return true;
}

function configureITerm2(scriptPath: string): boolean {
  // iTerm2 uses a plist — use defaults write
  try {
    const { execSync } = require("node:child_process");
    execSync(
      `defaults write com.googlecode.iterm2 "New Bookmarks" -array-add '<dict><key>Command</key><string>${scriptPath}</string><key>Custom Command</key><string>Yes</string></dict>'`,
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
  const configs = [
    join(home, ".config", "ghostty", "config"),
    join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"),
    join(home, ".config", "kitty", "kitty.conf"),
    join(home, ".config", "alacritty", "alacritty.toml"),
  ];
  for (const cfg of configs) {
    if (!existsSync(cfg)) continue;
    const content = readFileSync(cfg, "utf-8");
    if (content.includes("tmux") && (content.includes("command") || content.includes("shell"))) {
      return true;
    }
  }
  return false;
}

async function setupTerminal(
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  console.log(chalk.bold("\nTerminal Setup"));
  console.log(chalk.dim("──────────────"));

  if (userHasCmux()) {
    console.log(chalk.green("  ✓") + " cmux detected — built-in multiplexing, no tmux setup needed.");
    console.log(chalk.dim("  Overwatch will use tmux sessions alongside cmux.\n"));
  }

  if (userAlreadyHasTmux()) {
    console.log(chalk.green("  ✓") + " Detected existing tmux setup in your terminal config.");
    console.log(chalk.dim("  Skipping — your current setup will work with Overwatch.\n"));
    return;
  }

  console.log(
    chalk.dim(
      "Configure your terminal to auto-start tmux on new tabs."
    )
  );
  console.log(
    chalk.dim("This lets Overwatch discover and control your sessions.\n")
  );

  const terminals = detectTerminals();
  const detected = terminals.filter((t) => t.detected);

  if (detected.length === 0) {
    console.log(
      chalk.yellow("!") +
        " No supported terminals detected (Ghostty, Kitty, iTerm2, Alacritty, cmux)"
    );
    console.log(chalk.dim("  You can configure tmux manually later.\n"));
    return;
  }

  console.log("  Detected terminals:");
  detected.forEach((t) => console.log(`  ${chalk.green("✓")} ${t.name}`));
  console.log("");

  const scriptPath = installTmuxScript();
  console.log(
    chalk.green("  ✓") +
      ` Installed tmux script at ${scriptPath}\n`
  );

  for (const terminal of detected) {
    // cmux has built-in multiplexing — no tmux setup needed
    if (terminal.name === "cmux") {
      console.log(
        chalk.green("  ✓") +
          ` ${terminal.name} has built-in multiplexing — no tmux setup needed.`
      );
      continue;
    }

    const answer = await ask(
      rl,
      `  Configure ${terminal.name}? (Y/n): `
    );
    if (answer.trim().toLowerCase() === "n") continue;

    let configured = false;
    switch (terminal.name) {
      case "Ghostty":
        configured = configureGhostty(terminal.configPath, scriptPath);
        break;
      case "Kitty":
        configured = configureKitty(terminal.configPath, scriptPath);
        break;
      case "Alacritty":
        configured = configureAlacritty(terminal.configPath, scriptPath);
        break;
      case "iTerm2":
        configured = configureITerm2(scriptPath);
        break;
    }

    if (configured) {
      console.log(
        chalk.green("  ✓") +
          ` Updated ${terminal.name} config`
      );
      console.log(
        chalk.dim(
          `    Backup saved at ${terminal.configPath}.overwatch-backup`
        )
      );
    } else {
      console.log(
        chalk.dim(`  ${terminal.name} already configured — no changes needed.`)
      );
    }
  }
  console.log("");
}

// --- Main setup command ---

interface SetupOptions {
  deepgramKey?: string;
  cartesiaKey?: string;
  configureTerminal?: string;
  nonInteractive?: boolean;
}

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
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
      console.log(chalk.yellow("!") + " AI agent needs setup");
      console.log(
        chalk.dim("\n  Launching pi-coding-agent — follow the prompts to configure your provider.")
      );
      console.log(
        chalk.dim("  When done, type /exit or press Ctrl+C to return to setup.\n")
      );
      const { spawnSync } = await import("node:child_process");
      spawnSync("npx", ["@mariozechner/pi-coding-agent"], {
        stdio: "inherit",
        cwd: homedir(),
        shell: true,
      });
      if (existsSync(authPath)) {
        console.log(chalk.green("\n✓") + " AI agent configured");
      } else {
        console.log(chalk.yellow("\n!") + " Setup not completed — you can run `pi` later to set it up.");
      }
    }
  }
  console.log("");

  // Deepgram
  if (options.deepgramKey) {
    config.deepgramApiKey = options.deepgramKey;
    console.log(chalk.green("✓") + " Deepgram API key set");
  } else if (!ni) {
    const deepgram = await ask(
      rl,
      `Deepgram API key${config.deepgramApiKey ? chalk.dim(" (enter to keep current)") : ""}: `
    );
    if (deepgram.trim()) config.deepgramApiKey = deepgram.trim();
  }

  // Cartesia
  if (options.cartesiaKey) {
    config.cartesiaApiKey = options.cartesiaKey;
    console.log(chalk.green("✓") + " Cartesia API key set");
  } else if (!ni) {
    const cartesia = await ask(
      rl,
      `Cartesia API key${config.cartesiaApiKey ? chalk.dim(" (enter to keep current)") : ""}: `
    );
    if (cartesia.trim()) config.cartesiaApiKey = cartesia.trim();
  }

  // Relay URL (non-interactive uses default)
  if (!ni) {
    const relay = await ask(
      rl,
      `Relay URL${config.relayUrl ? chalk.dim(` (${config.relayUrl})`) : ""}: `
    );
    if (relay.trim()) config.relayUrl = relay.trim();
  }

  saveConfig(config);
  console.log("");
  console.log(
    chalk.green("✓") + ` Config saved to ${getConfigDir()}/config.json`
  );

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
    await setupTerminal(rl);
  }

  rl.close();

  console.log(`Run ${chalk.bold("overwatch start")} to begin.`);
}

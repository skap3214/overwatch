import { createInterface } from "node:readline";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import chalk from "chalk";
import prompts from "prompts";
import { getConfigDir, loadConfig, saveConfig } from "../config.js";
import {
  installGatewayService,
  setGatewayEnabled,
  startGatewayService,
  stopGatewayService,
  uninstallGatewayService,
} from "./gateway.js";
import {
  configureHermesHarnessConfig,
  enableHermesPlugin,
} from "../hermes-config.js";
import {
  installOverwatchSkills,
  normalizeSkillsSetupMode,
} from "../skills-setup.js";

function ask(
  rl: ReturnType<typeof createInterface>,
  question: string
): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue = true
): Promise<boolean> {
  const suffix = defaultValue ? " (Y/n): " : " (y/N): ";
  const answer = (await ask(rl, `${question}${suffix}`)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

interface AgentAuthState {
  configured: boolean;
  authPath: string;
  providers: string[];
}

function getAgentAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

function getAgentAuthState(): AgentAuthState {
  const authPath = getAgentAuthPath();
  if (!existsSync(authPath)) {
    return { configured: false, authPath, providers: [] };
  }

  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    const providers = Object.entries(raw)
      .filter(([, value]) => Boolean(value) && Object.keys(value).length > 0)
      .map(([provider]) => provider);
    return { configured: providers.length > 0, authPath, providers };
  } catch {
    return { configured: false, authPath, providers: [] };
  }
}

function importAgentAuth(sourcePath: string): string {
  const resolvedSource = sourcePath.startsWith("~")
    ? join(homedir(), sourcePath.slice(2))
    : sourcePath;
  if (!existsSync(resolvedSource)) {
    throw new Error(`Auth file not found: ${resolvedSource}`);
  }

  const raw = JSON.parse(readFileSync(resolvedSource, "utf-8")) as Record<
    string,
    Record<string, unknown>
  >;
  if (Object.keys(raw).length === 0) {
    throw new Error(`Auth file is empty: ${resolvedSource}`);
  }

  const authPath = getAgentAuthPath();
  mkdirSync(dirname(authPath), { recursive: true });
  if (existsSync(authPath) && resolvedSource !== authPath) {
    copyFileSync(authPath, `${authPath}.overwatch-backup`);
  }
  writeFileSync(authPath, JSON.stringify(raw, null, 2), "utf-8");
  chmodSync(authPath, 0o600);
  return authPath;
}

function getRawPiCommand(): string {
  try {
    execSync("command -v pi", { stdio: "ignore", shell: "/bin/bash" });
    return "pi";
  } catch {
    // continue to local fallbacks
  }
  const installed = join(homedir(), ".overwatch", "app", "node_modules", ".bin", "pi");
  if (existsSync(installed)) return installed;
  const local = join(process.cwd(), "node_modules", ".bin", "pi");
  if (existsSync(local)) return local;
  // Intentionally NOT returning `npx @mariozechner/pi-coding-agent` here. With
  // a global npmrc that enforces a minimum release age, an `npx` invocation
  // would hang trying to find an allowed version of a daily-publishing
  // package. Caller should treat an empty string as "pi not installed" and
  // print install instructions instead of shelling out blindly.
  return "";
}

function isPiInstalled(): boolean {
  return getRawPiCommand() !== "";
}

function piInstallInstruction(): string {
  return "npm install -g @mariozechner/pi-coding-agent";
}

async function loginWithSDK(
  rl: ReturnType<typeof createInterface>,
  preferredProvider?: string
): Promise<boolean> {
  const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
  const auth = AuthStorage.create();
  const providers = auth.getOAuthProviders();

  let providerId = preferredProvider?.trim().toLowerCase();
  if (providerId) {
    const match = providers.find(
      (provider: { id: string; name: string }) =>
        provider.id.toLowerCase() === providerId ||
        provider.name.toLowerCase() === providerId
    );
    if (!match) {
      console.log(
        chalk.yellow("  !") +
          ` Unknown provider "${preferredProvider}". Available: ${providers
            .map((provider: { id: string }) => provider.id)
            .join(", ")}\n`
      );
      return false;
    }
    providerId = match.id;
  } else {
    const response = await prompts({
      type: "select",
      name: "provider",
      message: "Select a provider to login",
      choices: providers.map((provider: { id: string; name: string }) => ({
        title: auth.hasAuth(provider.id)
          ? `${provider.name} ${chalk.green("✓ logged in")}`
          : provider.name,
        value: provider.id,
      })),
    });

    if (!response.provider) {
      console.log(
        chalk.dim(
          "  Skipped — you can rerun `overwatch setup --agent-provider <provider>` later.\n"
        )
      );
      return false;
    }
    providerId = response.provider;
  }

  if (!providerId) return false;

  try {
    const callbacks: Parameters<typeof auth.login>[1] & {
      onDeviceCode?: (info: {
        userCode: string;
        verificationUri: string;
      }) => void;
    } = {
      onAuth: (info: { url: string; instructions?: string }) => {
        console.log(chalk.dim(`  Opening browser for ${providerId} authentication...`));
        if (info.instructions) console.log(chalk.dim(`  ${info.instructions}`));
        try {
          execSync(`open "${info.url}"`);
        } catch {
          console.log(`  Open this URL: ${info.url}`);
        }
      },
      onDeviceCode: (info: { userCode: string; verificationUri: string }) => {
        console.log(chalk.yellow("  Human action required"));
        console.log(`  Visit: ${info.verificationUri}`);
        console.log(`  Enter code: ${chalk.bold(info.userCode)}`);
      },
      onPrompt: async (prompt: { message: string }) => {
        if (!process.stdin.isTTY) {
          throw new Error(
            `This provider requires typed input: "${prompt.message}". Run the command in a terminal and paste the requested value.`
          );
        }
        return ask(rl, `  ${prompt.message} `);
      },
      onProgress: (message: string) => {
        console.log(chalk.dim(`  ${message}`));
      },
    };

    await auth.login(providerId, callbacks);

    const updated = getAgentAuthState();
    const success = updated.providers.includes(providerId);
    if (success) {
      console.log(chalk.green("\n  ✓") + ` Logged into ${providerId}\n`);
    }
    return success;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authentication failed";
    console.log(chalk.yellow("\n  !") + ` ${message}\n`);
    return false;
  }
}

interface TerminalInfo {
  name: string;
  configPath: string;
  detected: boolean;
}

function detectTerminals(): TerminalInfo[] {
  const home = homedir();
  return [
    {
      name: "Ghostty",
      configPath: existsSync(join(home, ".config", "ghostty", "config"))
        ? join(home, ".config", "ghostty", "config")
        : existsSync(
              join(
                home,
                "Library",
                "Application Support",
                "com.mitchellh.ghostty",
                "config"
              )
            )
          ? join(
              home,
              "Library",
              "Application Support",
              "com.mitchellh.ghostty",
              "config"
            )
          : join(home, ".config", "ghostty", "config"),
      detected:
        existsSync(join(home, ".config", "ghostty", "config")) ||
        existsSync(
          join(
            home,
            "Library",
            "Application Support",
            "com.mitchellh.ghostty",
            "config"
          )
        ) ||
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
}

const TMUX_CONF = `# Overwatch tmux config — makes tmux invisible to users who didn't ask for it.
# Written by \`overwatch setup\`. Safe to delete; regenerated on next setup run.
# Users with their own ~/.tmux.conf still get their customizations — we source
# it at the end so personal overrides always win.

# ── server-wide responsiveness ──────────────────────────────────────────────

# Instant Esc. Default 500ms mis-tokenizes Opt+key sequences and makes vim
# feel laggy. 10ms is the oh-my-tmux compromise — still snappy, survives ssh.
set -sg escape-time 10

# Let FocusIn/Out reach apps inside tmux (nvim autoread, watchers, fzf).
set -sg focus-events on

# Extended keys (CSI-u). Enables Ctrl+Shift+<letter>, disambiguated Tab vs
# Ctrl+I, Enter vs Ctrl+M — everything modern terminals can emit.
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
set -as terminal-features 'xterm-ghostty:extkeys'
set -as terminal-features 'xterm-kitty:extkeys'

# Larger repeat window so -r bindings don't cut off mid-tap.
set -sg repeat-time 600

# ── colors, clipboard, underlines ───────────────────────────────────────────

# Modern 256-color TERM with italics + extended caps.
set -g default-terminal "tmux-256color"

# Truecolor passthrough. Without this, themes look washed out.
set -as terminal-features ',xterm-256color:RGB'
set -as terminal-features ',xterm-ghostty:RGB'
set -as terminal-features ',xterm-kitty:RGB'
set -as terminal-features ',alacritty:RGB'
set -as terminal-features ',iTerm.app:RGB'
set -as terminal-overrides ',xterm*:Tc'

# OSC 52 clipboard: selections inside tmux land in the macOS pasteboard.
# No pbcopy/xclip/reattach-to-user-namespace shim needed.
set -s set-clipboard on
set -as terminal-features ',xterm-256color:clipboard'
set -as terminal-features ',xterm-ghostty:clipboard'
set -as terminal-features ',xterm-kitty:clipboard'

# Styled / colored underlines (nvim diagnostics, etc.)
set -as terminal-features ',xterm-256color:usstyle'
set -as terminal-features ',xterm-ghostty:usstyle'
set -as terminal-features ',xterm-kitty:usstyle'

# Let apps inside tmux do OSC passthrough (kitty graphics, iterm2 images).
set -g allow-passthrough on

# ── day-one ergonomics ──────────────────────────────────────────────────────

# Mouse: scroll, click to focus pane, drag to select. Biggest "this is just
# a terminal" win. Hold Option on macOS to bypass for native text selection.
set -g mouse on

# 100k scrollback — default 2000 gets blown away by one npm install.
set -g history-limit 100000

# Silence. A bare shell doesn't flash on background output; neither should tmux.
set -g bell-action none
set -g visual-bell off
set -g visual-activity off
set -g monitor-activity off
set -g monitor-bell off

# Let apps own the terminal title.
set -g set-titles on
set -g set-titles-string "#{pane_title}"
set -g allow-rename on

# Windows/panes start at 1, match the keyboard. Close gaps on exit.
set -g base-index 1
setw -g pane-base-index 1
set -g renumber-windows on

# Resize to the smallest *currently visible* client, not the smallest
# attached — saner when multiple clients are in different sizes.
setw -g aggressive-resize on

# Emacs keys in the command prompt (prefix + :). Matches readline muscle memory.
set -g status-keys emacs

# Slightly longer message / pane-number display.
set -g display-time 2000
set -g display-panes-time 2000

# ── macOS-style key passthrough ─────────────────────────────────────────────
# Terminals send Home/End for Cmd+Left/Right; remap to readline start/end.
bind -n Home send-key C-a
bind -n End  send-key C-e

# Opt+Backspace → delete word, Opt+Delete → kill word forward.
bind -n M-BSpace send-key C-w
bind -n M-DC     send-key M-d

# Opt+Left/Right → jump by word (re-emit Meta escape sequences).
bind -n M-Left  send-key M-b
bind -n M-Right send-key M-f
bind -n M-b     send-key M-b
bind -n M-f     send-key M-f

# Ctrl+L clears screen AND tmux scrollback — matches the muscle memory of
# users who expect Cmd+K in macOS Terminal to wipe the buffer entirely.
bind -n C-l send-keys C-l \\; run-shell "sleep 0.1" \\; clear-history

# ── copy-mode: drag-to-copy, wheel scroll ───────────────────────────────────

# Emacs motion in copy-mode (readline-compatible, no vi surprise).
setw -g mode-keys emacs

# Release mouse after drag → copy to clipboard (OSC 52) and exit copy-mode,
# like macOS Terminal. Keeps selection visible until next click.
bind -T copy-mode MouseDragEnd1Pane send -X copy-pipe-and-cancel
bind -T copy-mode DoubleClick1Pane  send -X select-word \\; send -X copy-pipe-and-cancel
bind -T copy-mode TripleClick1Pane  send -X select-line \\; send -X copy-pipe-and-cancel

# Right-click / middle-click paste — matches Linux/macOS expectations.
bind -n MouseDown2Pane paste-buffer -p

# Esc cancels copy-mode (readline Esc already cancels prompts).
bind -T copy-mode Escape send -X cancel

# ── status bar: minimal, unobtrusive ────────────────────────────────────────

set -g status on
set -g status-interval 5
set -g status-position bottom
set -g status-left " #S "
set -g status-left-length 30
set -g status-right ""
set -g status-right-length 0
set -g status-style "bg=#333842,fg=#c5c8c6"
set -g status-left-style "bg=#81a2be,fg=#282c34,bold"
set -g window-status-format " #I:#W "
set -g window-status-current-format " #I:#W "
set -g window-status-current-style "bg=#282c34,fg=#ffffff,bold"
set -g window-status-style "bg=#333842,fg=#666666"
set -g pane-border-style "fg=#333333"
set -g pane-active-border-style "fg=#81a2be"
set -g message-style "bg=#282c34,fg=#f0c674"

# ── user overrides ──────────────────────────────────────────────────────────
# Anything in the user's personal tmux.conf wins over everything above.
if-shell "[ -f ~/.tmux.conf ]" "source-file -q ~/.tmux.conf"
`;

const TMUX_SCRIPT = `#!/bin/bash
# overwatch: auto-start tmux session on new terminal tab
[ -n "\$TMUX" ] && exec "\${SHELL:-/bin/zsh}"
if command -v brew &>/dev/null; then
  eval "\$(brew shellenv)"
elif [ -d "/opt/homebrew" ]; then
  eval "\$(/opt/homebrew/bin/brew shellenv)"
elif [ -d "/usr/local/Homebrew" ]; then
  eval "\$(/usr/local/bin/brew shellenv)"
fi
if ! command -v tmux &>/dev/null; then
  exec "\${SHELL:-/bin/zsh}"
fi
CONF="\$HOME/.overwatch/tmux.conf"
n=0
while tmux has-session -t "\$n" 2>/dev/null; do
  n=$((n + 1))
done
# -f loads our conf when the tmux server first starts. If a server is
# already running (pre-existing tmux), also source the conf explicitly
# so its options apply to the new session. Both paths are idempotent.
if [ -f "\$CONF" ]; then
  if tmux info &>/dev/null; then
    tmux source-file -q "\$CONF" 2>/dev/null || true
    exec tmux new-session -s "\$n"
  fi
  exec tmux -f "\$CONF" new-session -s "\$n"
fi
exec tmux new-session -s "\$n"
`;

function installTmuxScript(): string {
  const scriptPath = join(getConfigDir(), "tmux-session.sh");
  const confPath = join(getConfigDir(), "tmux.conf");
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(scriptPath, TMUX_SCRIPT, "utf-8");
  chmodSync(scriptPath, 0o755);
  writeFileSync(confPath, TMUX_CONF, "utf-8");
  return scriptPath;
}

function backupFile(path: string): string {
  const backup = `${path}.overwatch-backup`;
  if (!existsSync(backup) && existsSync(path)) {
    copyFileSync(path, backup);
  }
  return backup;
}

function configureGhostty(configPath: string, scriptPath: string): boolean {
  const configDir = dirname(configPath);
  mkdirSync(configDir, { recursive: true });

  const content = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";

  if (content.includes("overwatch/tmux-session.sh")) return false;

  if (content.match(/^command\s*=/m)) {
    const updated = content.replace(
      /^(command\s*=.*)$/m,
      `# $1  # commented by overwatch\ncommand = ${scriptPath}`
    );
    backupFile(configPath);
    writeFileSync(configPath, updated, "utf-8");
  } else {
    backupFile(configPath);
    writeFileSync(
      configPath,
      `${content}\n# Added by overwatch — auto-start tmux on new tab\ncommand = ${scriptPath}\n`,
      "utf-8"
    );
  }
  return true;
}

function configureKitty(configPath: string, scriptPath: string): boolean {
  const content = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";

  if (content.includes("overwatch/tmux-session.sh")) return false;

  backupFile(configPath);
  writeFileSync(
    configPath,
    `${content}\n# Added by overwatch — auto-start tmux on new tab\nshell ${scriptPath}\n`,
    "utf-8"
  );
  return true;
}

function configureAlacritty(configPath: string, scriptPath: string): boolean {
  mkdirSync(dirname(configPath), { recursive: true });
  const content = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";

  if (content.includes("overwatch/tmux-session.sh")) return false;

  backupFile(configPath);
  if (content.includes("[terminal.shell]")) {
    const updated = content.replace(
      /\[terminal\.shell\]\s*\nprogram\s*=.*/,
      `[terminal.shell]\nprogram = "${scriptPath}"`
    );
    writeFileSync(configPath, updated, "utf-8");
  } else if (content.includes("[shell]")) {
    const updated = content.replace(
      /\[shell\]\s*\nprogram\s*=.*/,
      `[terminal.shell]\nprogram = "${scriptPath}"`
    );
    writeFileSync(configPath, updated, "utf-8");
  } else {
    writeFileSync(
      configPath,
      `${content}\n# Added by overwatch — auto-start tmux on new tab\n[terminal.shell]\nprogram = "${scriptPath}"\n`,
      "utf-8"
    );
  }
  return true;
}

function configureITerm2(scriptPath: string): boolean {
  const plistPath = join(
    homedir(),
    "Library",
    "Preferences",
    "com.googlecode.iterm2.plist"
  );
  if (!existsSync(plistPath)) return false;

  try {
    const current = execSync(
      `/usr/libexec/PlistBuddy -c "Print :New\\ Bookmarks:0:Command" "${plistPath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (current.includes("overwatch/tmux-session.sh")) return false;
  } catch {
    // missing command is fine
  }

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
  return (
    existsSync("/Applications/cmux.app") ||
    existsSync(join(homedir(), "Library", "Application Support", "cmux"))
  );
}

function hasTmuxAutoStartConfigured(): boolean {
  const home = homedir();
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

  const itermPath = join(
    home,
    "Library",
    "Preferences",
    "com.googlecode.iterm2.plist"
  );
  if (existsSync(itermPath)) {
    try {
      const command = execSync(
        `/usr/libexec/PlistBuddy -c "Print :New\\ Bookmarks:0:Command" "${itermPath}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      if (command.includes("tmux")) return true;
    } catch {
      // ignore
    }
  }

  return false;
}

function configureTerminalByName(
  name: string,
  configPath: string,
  scriptPath: string
): boolean {
  switch (name) {
    case "Ghostty":
      return configureGhostty(configPath, scriptPath);
    case "Kitty":
      return configureKitty(configPath, scriptPath);
    case "Alacritty":
      return configureAlacritty(configPath, scriptPath);
    case "iTerm2":
      return configureITerm2(scriptPath);
    default:
      return false;
  }
}

function normalizeTerminalName(name: string): string {
  return name.trim().toLowerCase();
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

async function setupTerminal(): Promise<boolean> {
  console.log(chalk.bold("\nTerminal Setup"));
  console.log(chalk.dim("──────────────"));

  if (!commandExists("tmux")) {
    console.log(
      chalk.yellow("  !") +
        " tmux is missing. Re-run the installer so it can provision tmux first.\n"
    );
    return false;
  }

  if (userHasCmux()) {
    console.log(
      chalk.green("  ✓") +
        " cmux detected — Overwatch can run without changing your terminal config.\n"
    );
    return false;
  }

  const terminals = detectTerminals().filter(
    (terminal) => terminal.detected && terminal.name !== "cmux"
  );

  if (terminals.length === 0) {
    console.log(
      chalk.yellow("  !") +
        " No supported terminals detected (Ghostty, Kitty, iTerm2, Alacritty).\n"
    );
    return false;
  }

  if (hasTmuxAutoStartConfigured()) {
    console.log(chalk.green("  ✓") + " tmux auto-start already looks configured.\n");
    return false;
  }

  console.log(
    chalk.dim(
      "  Pick the terminals that should auto-open a fresh tmux session on new tabs.\n"
    )
  );

  const response = await prompts({
    type: "multiselect",
    name: "terminals",
    message: "Select terminals to configure",
    choices: terminals.map((terminal) => ({
      title: terminal.name,
      value: terminal.name,
      selected: true,
    })),
    hint: "Space to toggle, Enter to confirm",
  });

  if (!response.terminals || response.terminals.length === 0) {
    console.log(chalk.dim("  No terminals selected — skipping.\n"));
    return false;
  }

  const scriptPath = installTmuxScript();
  let configuredAny = false;

  for (const terminalName of response.terminals as string[]) {
    const terminal = terminals.find((item) => item.name === terminalName);
    if (!terminal) continue;

    const configured = configureTerminalByName(
      terminal.name,
      terminal.configPath,
      scriptPath
    );
    if (configured) {
      configuredAny = true;
      console.log(chalk.green("  ✓") + ` Configured ${terminal.name}`);
      if (terminal.name !== "iTerm2") {
        console.log(
          chalk.dim(`    Backup saved to ${terminal.configPath}.overwatch-backup`)
        );
      }
    } else {
      console.log(chalk.dim(`  ${terminal.name} already configured`));
    }
  }

  console.log("");
  return configuredAny;
}

function normalizeTerminalInputs(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function configureTerminalsNonInteractive(names: string[]): boolean {
  const normalizedNames = normalizeTerminalInputs(names);
  if (normalizedNames.length === 0) return false;

  const normalizedSet = new Set(normalizedNames.map(normalizeTerminalName));
  if (normalizedSet.has("none") || normalizedSet.has("skip")) {
    console.log(chalk.dim("  Terminal configuration skipped by flag."));
    return false;
  }

  const terminals = detectTerminals().filter((terminal) => terminal.name !== "cmux");
  const scriptPath = installTmuxScript();
  let configuredAny = false;

  for (const terminalName of normalizedNames) {
    const normalized = normalizeTerminalName(terminalName);
    if (normalized === "cmux") {
      console.log(chalk.dim("  cmux selected — no terminal file edits needed."));
      continue;
    }

    const terminal = terminals.find(
      (item) => normalizeTerminalName(item.name) === normalized,
    );
    if (!terminal) {
      throw new Error(
        `Unknown terminal "${terminalName}". Use one of: ghostty, kitty, alacritty, iterm2, cmux, none.`,
      );
    }

    const configured = configureTerminalByName(
      terminal.name,
      terminal.configPath,
      scriptPath,
    );
    if (configured) {
      configuredAny = true;
      console.log(chalk.green("✓") + ` Configured ${terminal.name}`);
    } else {
      console.log(chalk.dim(`  ${terminal.name} already configured`));
    }
  }

  return configuredAny;
}

interface SetupOptions {
  agent?: string;
  agentAuthFile?: string;
  agentProvider?: string;
  terminal?: string[];
  deepgramKey?: string;
  stt?: string;
  tts?: string;
  sttModel?: string;
  ttsModel?: string;
  gateway?: string;
  skills?: string;
  nonInteractive?: boolean;
}

type AgentId = "pi-coding-agent" | "claude-code-cli" | "hermes";

function normalizeAgentId(value: string | undefined): AgentId {
  const normalized = (value ?? "pi-coding-agent").trim().toLowerCase();
  if (
    normalized === "pi-coding-agent" ||
    normalized === "claude-code-cli" ||
    normalized === "hermes"
  ) {
    return normalized;
  }
  throw new Error(
    `Unknown agent "${value}". Use one of: pi-coding-agent, claude-code-cli, hermes.`,
  );
}

function normalizeSpeechProvider(kind: "stt" | "tts", value: string): "deepgram" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "deepgram") return "deepgram";
  throw new Error(`Unknown ${kind.toUpperCase()} provider "${value}". Only deepgram is supported for now.`);
}

function configureGateway(mode: string): void {
  const normalized = mode.trim().toLowerCase();
  if (normalized === "on") {
    installGatewayService();
    startGatewayService();
    setGatewayEnabled(true);
    console.log(chalk.green("✓") + " Gateway enabled");
    return;
  }
  if (normalized === "off") {
    setGatewayEnabled(false);
    stopGatewayService();
    uninstallGatewayService();
    console.log(chalk.green("✓") + " Gateway disabled");
    return;
  }
  throw new Error(`Unknown gateway mode "${mode}". Use "on" or "off".`);
}

function printRemainingActions(options: {
  configHasDeepgram: boolean;
  agentId: AgentId;
  agentState: AgentAuthState;
  terminalReady: boolean;
  skillsReady: boolean;
}): void {
  const actions: string[] = [];
  if (options.agentId === "pi-coding-agent" && !options.agentState.configured) {
    if (isPiInstalled()) {
      actions.push(
        `Authenticate a Pi provider. Best path: \`overwatch setup --agent-provider anthropic\`. Raw fallback: \`${getRawPiCommand()}\` then run \`/login\`.`
      );
    } else {
      actions.push(
        `Install pi-coding-agent first: \`${piInstallInstruction()}\`, then run \`overwatch setup --agent-provider anthropic\`.`
      );
    }
  } else if (options.agentId === "claude-code-cli" && !commandExists("claude")) {
    actions.push("Install Claude Code CLI so `claude` is available on PATH.");
  }
  if (!options.configHasDeepgram) {
    actions.push(
      "Add a Deepgram key with `overwatch setup --deepgram-key <KEY>`."
    );
  }
  if (!options.terminalReady) {
    actions.push(
      "Configure a supported terminal with `overwatch setup --terminal ghostty` (or kitty/alacritty/iterm2)."
    );
  }
  if (!options.skillsReady) {
    actions.push(
      "Install the Overwatch skill by rerunning `overwatch setup --skills on`; setup uses `npx skills@latest add <skill-source> --global --all --copy` for `.agents/skills/overwatch`."
    );
  }

  if (actions.length === 0) {
    console.log(chalk.green("\n✓ Setup complete"));
    console.log("Run `overwatch start` to begin.");
    return;
  }

  console.log(chalk.yellow("\n! Setup still needs attention"));
  for (const action of actions) {
    console.log(`  - ${action}`);
  }
  console.log("");
}

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  const nonInteractive = options.nonInteractive ?? false;
  const skillsMode = normalizeSkillsSetupMode(options.skills);
  let rl = createInterface({ input: process.stdin, output: process.stdout });
  let config = loadConfig();
  const agentId = normalizeAgentId(
    options.agent ??
      (options.agentProvider || options.agentAuthFile ? "pi-coding-agent" : config.harness),
  );

  console.log("");
  console.log(chalk.bold("Overwatch Setup"));
  console.log(chalk.dim("───────────────"));
  console.log("");

  console.log(chalk.green("✓") + ` Agent set to ${agentId}`);
  config.harness = agentId;

  let agentState = getAgentAuthState();
  if (agentId === "pi-coding-agent") {
    if (agentState.configured) {
      console.log(
        chalk.green("✓") +
          ` Pi agent auth present (${agentState.providers.join(", ")})`
      );
    } else {
      console.log(chalk.yellow("!") + " Pi agent auth not configured yet");
    }

    if (options.agentAuthFile) {
      try {
        const authPath = importAgentAuth(options.agentAuthFile);
        agentState = getAgentAuthState();
        console.log(chalk.green("✓") + ` Imported agent auth into ${authPath}`);
      } catch (error) {
        console.log(
          chalk.red("✗") +
            ` ${
              error instanceof Error ? error.message : "Failed to import agent auth"
            }`
        );
      }
    } else if (!agentState.configured || options.agentProvider) {
      // Skip the login flow if pi-coding-agent isn't installed at all — the
      // dynamic import inside loginWithSDK would crash with a confusing module
      // resolution error. Tell the user how to install it instead.
      if (!isPiInstalled()) {
        console.log(
          chalk.yellow("  !") +
            " pi-coding-agent is not installed yet — skipping provider login."
        );
        console.log(
          chalk.dim(
            `  Install it with: ${chalk.bold(piInstallInstruction())}\n` +
              "  Then re-run: overwatch setup --agent-provider anthropic\n"
          )
        );
      } else if (options.agentProvider) {
        const loggedIn = await loginWithSDK(rl, options.agentProvider);
        if (loggedIn) agentState = getAgentAuthState();
        rl.close();
        rl = createInterface({ input: process.stdin, output: process.stdout });
      } else if (!nonInteractive) {
        const shouldLogin = await askYesNo(
          rl,
          "Configure Pi provider login now?",
          !agentState.configured
        );
        if (shouldLogin) {
          const loggedIn = await loginWithSDK(rl);
          if (loggedIn) agentState = getAgentAuthState();
          rl.close();
          rl = createInterface({ input: process.stdin, output: process.stdout });
        }
      }
    }
  } else if (agentId === "hermes") {
    config = configureHermesHarnessConfig(config);
    console.log(chalk.green("✓") + " Hermes harness configured from ~/.hermes/config.yaml");
    try {
      await enableHermesPlugin(config);
      console.log(chalk.green("✓") + " Hermes Overwatch plugin enabled");
    } catch (error) {
      console.log(
        chalk.yellow("!") +
          ` Hermes plugin setup skipped: ${
            error instanceof Error ? error.message : "unknown error"
          }`
      );
    }
  } else if (!commandExists("claude")) {
    console.log(chalk.yellow("!") + " Claude Code CLI is not installed or not on PATH.");
  }

  console.log("");

  if (options.stt) {
    config.sttProvider = normalizeSpeechProvider("stt", options.stt);
    console.log(chalk.green("✓") + ` STT provider set to ${config.sttProvider}`);
  }
  if (options.tts) {
    config.ttsProvider = normalizeSpeechProvider("tts", options.tts);
    console.log(chalk.green("✓") + ` TTS provider set to ${config.ttsProvider}`);
  }
  if (options.sttModel) {
    config.sttProvider = config.sttProvider ?? "deepgram";
    config.sttModel = options.sttModel.trim();
    console.log(chalk.green("✓") + ` STT model set to ${config.sttModel}`);
  }
  if (options.ttsModel) {
    config.ttsProvider = config.ttsProvider ?? "deepgram";
    config.ttsModel = options.ttsModel.trim();
    console.log(chalk.green("✓") + ` TTS model set to ${config.ttsModel}`);
  }
  if (options.deepgramKey) {
    config.deepgramApiKey = options.deepgramKey.trim();
    config.sttProvider = config.sttProvider ?? "deepgram";
    config.ttsProvider = config.ttsProvider ?? "deepgram";
    console.log(chalk.green("✓") + " Deepgram API key set for STT + TTS");
  } else if (!nonInteractive) {
    const answer = await ask(
      rl,
      `Deepgram API key (used for STT + TTS)${
        config.deepgramApiKey ? chalk.dim(" (enter to keep current)") : ""
      }: `
    );
    if (answer.trim()) {
      config.deepgramApiKey = answer.trim();
      console.log(chalk.green("✓") + " Deepgram API key updated");
    }
  }

  saveConfig(config);
  console.log(chalk.green("✓") + ` Config saved to ${getConfigDir()}/config.json`);

  if (options.gateway) {
    configureGateway(options.gateway);
  }

  let skillsReady = true;
  if (skillsMode === "on") {
    console.log("");
    console.log(chalk.bold("Agent Skills"));
    console.log(chalk.dim("────────────"));
    const installed = installOverwatchSkills();
    for (const result of installed) {
      if (result.ok) {
        console.log(chalk.green("✓") + ` Installed ${result.name} skill`);
      } else {
        skillsReady = false;
        console.log(
          chalk.yellow("!") +
            ` ${result.name} skill setup failed: ${result.error}`
        );
      }
    }
  } else {
    console.log(chalk.dim("  Agent skills setup skipped by flag."));
  }

  installTmuxScript();

  let terminalsConfigured = false;
  if (options.terminal && options.terminal.length > 0) {
    terminalsConfigured = configureTerminalsNonInteractive(options.terminal);
  } else if (!nonInteractive) {
    terminalsConfigured = await setupTerminal();
  }

  rl.close();

  const terminalReady = userHasCmux() || hasTmuxAutoStartConfigured();
  if (terminalsConfigured) {
    console.log(
      chalk.yellow(
        "\n  Restart your terminal after this setup so new tabs pick up the tmux bootstrap."
      )
    );
  }

  printRemainingActions({
    configHasDeepgram: Boolean(config.deepgramApiKey),
    agentId,
    agentState,
    terminalReady,
    skillsReady,
  });
}

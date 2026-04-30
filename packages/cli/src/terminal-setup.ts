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
import { getConfigDir } from "./config.js";

const OVERWATCH_MARKER_START = "# >>> overwatch tmux auto-start >>>";
const OVERWATCH_MARKER_END = "# <<< overwatch tmux auto-start <<<";
const OVERWATCH_SCRIPT_FRAGMENT = "overwatch/tmux-session.sh";

type TextConfigStatus = "updated" | "unchanged" | "skipped";

export interface TextConfigEdit {
  status: TextConfigStatus;
  content: string;
  reason?: string;
}

export interface TerminalInfo {
  name: string;
  configPath: string;
  detected: boolean;
}

export interface TerminalSetupResult {
  configuredAny: boolean;
  skipped: boolean;
}

interface TerminalConfigResult {
  terminal: string;
  status: "configured" | "unchanged" | "skipped";
  configPath?: string;
  reason?: string;
}

export function createNativeFirstTmuxConfig(): string {
  return `# Overwatch tmux config - native-first managed profile.
# Written by \`overwatch setup\`. Safe to delete; regenerated on next setup run.
#
# Goal: make tmux feel like the user's terminal without tmux. Existing tmux
# users should skip terminal setup and keep their own tmux.conf instead.

# -- server-wide responsiveness ---------------------------------------------

# Instant Esc. Default 500ms mis-tokenizes Opt+key sequences and makes vim
# feel laggy. 10ms keeps terminals responsive while still tolerating ssh.
set -sg escape-time 10

# Let FocusIn/Out reach apps inside tmux (nvim autoread, watchers, fzf).
set -sg focus-events on

# Extended keys in CSI-u format. Disambiguates Shift+Enter, Ctrl+Enter,
# Ctrl+Shift+<letter>, Tab vs Ctrl+I, Enter vs Ctrl+M - what Ghostty / Kitty /
# iTerm2 / WezTerm natively emit and what pi-coding-agent expects.
#
# Known regression on the claude-code-cli harness: tmux re-encodes CR/LF
# inside bracketed paste as CSI-u, and Claude Code's paste tokenizer doesn't
# decode it (anthropics/claude-code#43169). Users on that harness who hit it
# can drop 'set -s extended-keys-format xterm' into ~/.tmux.conf to override.
set -s extended-keys on
set -s extended-keys-format csi-u
set -as terminal-features 'xterm*:extkeys'
set -as terminal-features 'xterm-ghostty:extkeys'
set -as terminal-features 'xterm-kitty:extkeys'

# Larger repeat window so repeated tmux internals do not cut off mid-tap.
set -sg repeat-time 600

# -- colors, clipboard, underlines ------------------------------------------

# Modern 256-color TERM with italics and extended caps.
set -g default-terminal "tmux-256color"

# Truecolor passthrough. Without this, themes look washed out.
set -as terminal-features ',xterm-256color:RGB'
set -as terminal-features ',xterm-ghostty:RGB'
set -as terminal-features ',xterm-kitty:RGB'
set -as terminal-features ',alacritty:RGB'
set -as terminal-features ',iTerm.app:RGB'
set -as terminal-overrides ',xterm*:Tc'

# OSC 52 clipboard: selections inside tmux can reach the system clipboard
# without pbcopy/xclip/reattach-to-user-namespace shims.
set -s set-clipboard on
set -as terminal-features ',xterm-256color:clipboard'
set -as terminal-features ',xterm-ghostty:clipboard'
set -as terminal-features ',xterm-kitty:clipboard'

# Styled / colored underlines (nvim diagnostics, etc.).
set -as terminal-features ',xterm-256color:usstyle'
set -as terminal-features ',xterm-ghostty:usstyle'
set -as terminal-features ',xterm-kitty:usstyle'

# Let apps inside tmux do OSC passthrough (kitty graphics, iTerm2 images).
set -g allow-passthrough on

# -- day-one ergonomics ------------------------------------------------------

# Mouse: scroll, click to focus pane, drag to select. Hold Option on macOS
# to bypass tmux for native terminal text selection.
set -g mouse on

# 100k scrollback - default 2000 gets blown away by one npm install.
set -g history-limit 100000

# Silence. A bare shell does not flash on background output; neither should
# Overwatch-managed tmux.
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

# Resize to the smallest currently visible client, not the smallest attached
# client. Saner when multiple clients are in different sizes.
setw -g aggressive-resize on

# Emacs keys in the command prompt (prefix + :). Matches readline muscle memory.
set -g status-keys emacs

# Slightly longer tmux messages if one appears.
set -g display-time 2000
set -g display-panes-time 2000

# Predictable double-click word selection - matches macOS Terminal/iTerm2.
set -g word-separators ' ()[]{}<>|;:&"'

# -- mouse wheel: native-feel scroll ----------------------------------------
# When inside an alt-screen app (less/man/vim/htop/Claude TUI), forward the
# wheel as Up/Down arrow keys so the app scrolls itself, instead of popping
# tmux copy-mode on top of the alt screen - which is what made scrolling
# feel "broken" before. Outside the alt screen, enter copy-mode and scroll
# tmux's scrollback. Verbatim from the tmux wiki Recipes page.
bind -n WheelUpPane {
  if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } {
    if -F '#{alternate_on}' { send-keys -N 3 Up } { copy-mode -e }
  }
}
bind -n WheelDownPane {
  if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } {
    if -F '#{alternate_on}' { send-keys -N 3 Down }
  }
}

# Smoother wheel inside copy-mode. Default 5 rows/tick feels jerky next to
# Ghostty's pixel scroll.
bind -T copy-mode WheelUpPane   send -X -N 3 scroll-up
bind -T copy-mode WheelDownPane send -X -N 3 scroll-down

# -- macOS-style key passthrough --------------------------------------------
# Terminals send Home/End for Cmd+Left/Right; remap to readline start/end.
bind -n Home send-key C-a
bind -n End  send-key C-e

# Opt+Backspace -> delete word, Opt+Delete -> kill word forward.
bind -n M-BSpace send-key C-w
bind -n M-DC     send-key M-d

# Opt+Left/Right -> jump by word (re-emit Meta escape sequences).
bind -n M-Left  send-key M-b
bind -n M-Right send-key M-f
bind -n M-b     send-key M-b
bind -n M-f     send-key M-f

# Ctrl+L clears screen AND tmux scrollback. Ghostty's native Cmd+K only
# clears the primary screen, but tmux owns the alt screen - the managed
# Ghostty/Kitty/Alacritty config relays Cmd+K -> Ctrl+L so the keybind
# reaches this binding.
bind -n C-l send-keys C-l \\; run-shell "sleep 0.1" \\; clear-history

# -- copy-mode: drag-to-copy, native-feel selection -------------------------

# Emacs motion in copy-mode (readline-compatible, no vi surprise).
setw -g mode-keys emacs

# Release mouse after drag -> copy to system clipboard via OSC52 and exit
# copy-mode, like macOS Terminal/iTerm2 with "Copy on Selection" enabled.
bind -T copy-mode MouseDragEnd1Pane send -X copy-pipe-and-cancel
bind -T copy-mode DoubleClick1Pane  send -X select-word \\; send -X copy-pipe-and-cancel
bind -T copy-mode TripleClick1Pane  send -X select-line \\; send -X copy-pipe-and-cancel

# Middle-click paste - matches Linux/macOS expectations.
bind -n MouseDown2Pane paste-buffer -p

# Esc cancels copy-mode (readline Esc already cancels prompts).
bind -T copy-mode Escape send -X cancel

# -- status bar: minimal, unobtrusive ---------------------------------------

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

# -- user overrides ---------------------------------------------------------
# Anything in the user's personal tmux.conf wins over everything above.
if-shell "[ -f ~/.tmux.conf ]" "source-file -q ~/.tmux.conf"
`;
}

export function createTmuxSessionScript(): string {
  return `#!/bin/bash
# overwatch: auto-start tmux session on new terminal tab
if [ -n "$TMUX" ]; then
  exec "\${SHELL:-/bin/zsh}" -l
fi
if command -v brew &>/dev/null; then
  eval "$(brew shellenv)"
elif [ -x "/opt/homebrew/bin/brew" ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x "/usr/local/bin/brew" ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi
if ! command -v tmux &>/dev/null; then
  exec "\${SHELL:-/bin/zsh}" -l
fi
CONF="$HOME/.overwatch/tmux.conf"
SHELL_CMD="\${SHELL:-/bin/zsh} -l"
n=0
while tmux has-session -t "$n" 2>/dev/null; do
  n=$((n + 1))
done
if [ -f "$CONF" ]; then
  exec tmux -f "$CONF" new-session -s "$n" "$SHELL_CMD"
fi
exec tmux new-session -s "$n" "$SHELL_CMD"
`;
}

export function getTmuxScriptPath(): string {
  return join(getConfigDir(), "tmux-session.sh");
}

export function installManagedTmuxBootstrap(): string {
  const scriptPath = getTmuxScriptPath();
  const confPath = join(getConfigDir(), "tmux.conf");
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(scriptPath, createTmuxSessionScript(), "utf-8");
  chmodSync(scriptPath, 0o755);
  writeFileSync(confPath, createNativeFirstTmuxConfig(), "utf-8");
  return scriptPath;
}

export function detectTerminals(): TerminalInfo[] {
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
                "config",
              ),
            )
          ? join(
              home,
              "Library",
              "Application Support",
              "com.mitchellh.ghostty",
              "config",
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
            "config",
          ),
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
        "com.googlecode.iterm2.plist",
      ),
      detected: existsSync(
        join(home, "Library", "Preferences", "com.googlecode.iterm2.plist"),
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

export function userHasCmux(): boolean {
  return (
    existsSync("/Applications/cmux.app") ||
    existsSync(join(homedir(), "Library", "Application Support", "cmux"))
  );
}

export function normalizeTerminalInputs(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isTerminalSetupSkipRequest(values: string[] | undefined): boolean {
  const normalized = normalizeTerminalInputs(values).map(normalizeTerminalName);
  return normalized.some(
    (value) =>
      value === "none" ||
      value === "skip" ||
      value === "existing-tmux" ||
      value === "existing_tmux",
  );
}

export function buildGhosttyConfig(content: string, scriptPath: string): TextConfigEdit {
  if (hasOverwatchManagedBlock(content)) {
    return replaceManagedBlock(content, ghosttyManagedBody(scriptPath));
  }
  if (content.includes(OVERWATCH_SCRIPT_FRAGMENT)) {
    return {
      status: "unchanged",
      content,
      reason: "Overwatch auto-start is already present.",
    };
  }
  if (hasActiveLine(content, /^command\s*=/)) {
    return {
      status: "skipped",
      content,
      reason: "existing Ghostty command would be overwritten",
    };
  }
  return appendManagedBlock(content, ghosttyManagedBody(scriptPath));
}

export function buildKittyConfig(content: string, scriptPath: string): TextConfigEdit {
  if (hasOverwatchManagedBlock(content)) {
    return replaceManagedBlock(content, kittyManagedBody(scriptPath));
  }
  if (content.includes(OVERWATCH_SCRIPT_FRAGMENT)) {
    return {
      status: "unchanged",
      content,
      reason: "Overwatch auto-start is already present.",
    };
  }
  if (hasActiveLine(content, /^shell\s+/)) {
    return {
      status: "skipped",
      content,
      reason: "existing Kitty shell would be overwritten",
    };
  }
  return appendManagedBlock(content, kittyManagedBody(scriptPath));
}

export function buildAlacrittyConfig(content: string, scriptPath: string): TextConfigEdit {
  if (hasOverwatchManagedBlock(content)) {
    return replaceManagedBlock(content, alacrittyManagedBody(scriptPath));
  }
  if (content.includes(OVERWATCH_SCRIPT_FRAGMENT)) {
    return {
      status: "unchanged",
      content,
      reason: "Overwatch auto-start is already present.",
    };
  }
  if (hasAlacrittyShellSection(content)) {
    return {
      status: "skipped",
      content,
      reason: "existing Alacritty shell block would be overwritten",
    };
  }
  return appendManagedBlock(content, alacrittyManagedBody(scriptPath));
}

export function hasTmuxAutoStartConfigured(): boolean {
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
    "com.googlecode.iterm2.plist",
  );
  if (existsSync(itermPath)) {
    try {
      const command = execSync(
        `/usr/libexec/PlistBuddy -c "Print :New\\ Bookmarks:0:Command" "${itermPath}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (command.includes("tmux")) return true;
    } catch {
      // Ignore unreadable iTerm2 command state.
    }
  }

  return false;
}

export function hasOverwatchAutoStartConfigured(): boolean {
  const home = homedir();
  const termConfigs = [
    join(home, ".config", "ghostty", "config"),
    join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"),
    join(home, ".config", "kitty", "kitty.conf"),
    join(home, ".config", "alacritty", "alacritty.toml"),
  ];
  for (const configPath of termConfigs) {
    if (!existsSync(configPath)) continue;
    const content = readFileSync(configPath, "utf-8");
    if (content.includes(OVERWATCH_SCRIPT_FRAGMENT)) return true;
  }

  const itermPath = join(
    home,
    "Library",
    "Preferences",
    "com.googlecode.iterm2.plist",
  );
  if (existsSync(itermPath)) {
    try {
      const command = execSync(
        `/usr/libexec/PlistBuddy -c "Print :New\\ Bookmarks:0:Command" "${itermPath}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (command.includes(OVERWATCH_SCRIPT_FRAGMENT)) return true;
    } catch {
      // Ignore unreadable iTerm2 command state.
    }
  }

  return false;
}

export function detectExistingTmuxSignals(): string[] {
  const home = homedir();
  const signals: string[] = [];

  if (process.env.TMUX) signals.push("running inside tmux");
  if (existsSync(join(home, ".tmux.conf"))) signals.push("~/.tmux.conf");

  try {
    const sessions = execSync("tmux list-sessions", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: "/bin/bash",
    }).trim();
    if (sessions) signals.push("active tmux server");
  } catch {
    // No tmux server is a normal state.
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
    if (
      !content.includes(OVERWATCH_SCRIPT_FRAGMENT) &&
      /^\s*(exec\s+)?tmux\b|tmux\s+new-session|tmux\s+attach/m.test(content)
    ) {
      signals.push(`${rcFile} starts tmux`);
      break;
    }
  }

  return Array.from(new Set(signals));
}

export async function setupTerminal(): Promise<TerminalSetupResult> {
  console.log(chalk.bold("\nTerminal Setup"));
  console.log(chalk.dim("--------------"));

  if (!commandExists("tmux")) {
    console.log(
      chalk.yellow("  !") +
        " tmux is missing. Re-run the installer so it can provision tmux first.\n",
    );
    return { configuredAny: false, skipped: false };
  }

  if (userHasCmux()) {
    console.log(
      chalk.green("  OK") +
        " cmux detected - Overwatch can run without changing your terminal config.\n",
    );
    return { configuredAny: false, skipped: true };
  }

  if (hasOverwatchAutoStartConfigured()) {
    installManagedTmuxBootstrap();
    console.log(
      chalk.green("  OK") +
        " Overwatch tmux auto-start already configured; refreshed managed tmux files.\n",
    );
    return { configuredAny: false, skipped: false };
  }

  const existingSignals = detectExistingTmuxSignals();
  if (existingSignals.length > 0) {
    console.log(chalk.yellow("  !") + " Existing tmux setup detected:");
    for (const signal of existingSignals.slice(0, 4)) {
      console.log(chalk.dim(`    - ${signal}`));
    }
    const response = await prompts({
      type: "confirm",
      name: "skip",
      message: "Leave your tmux and terminal setup unchanged?",
      initial: true,
    });
    if (response.skip !== false) {
      console.log(
        chalk.dim(
          "  Tmux setup skipped. Overwatch will use tmux sessions you create yourself.\n",
        ),
      );
      return { configuredAny: false, skipped: true };
    }
  }

  const terminals = detectTerminals().filter(
    (terminal) => terminal.detected && terminal.name !== "cmux",
  );

  if (terminals.length === 0) {
    console.log(
      chalk.yellow("  !") +
        " No supported terminals detected (Ghostty, Kitty, iTerm2, Alacritty).\n",
    );
    return { configuredAny: false, skipped: false };
  }

  console.log(
    chalk.dim(
      "  Pick the terminals that should auto-open a fresh tmux session on new tabs.\n",
    ),
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
    console.log(chalk.dim("  No terminals selected - skipping.\n"));
    return { configuredAny: false, skipped: true };
  }

  let configuredAny = false;
  for (const terminalName of response.terminals as string[]) {
    const terminal = terminals.find((item) => item.name === terminalName);
    if (!terminal) continue;
    const result = configureTerminalByName(terminal.name, terminal.configPath);
    configuredAny = printTerminalConfigResult(result) || configuredAny;
  }

  console.log("");
  return { configuredAny, skipped: false };
}

export function configureTerminalsNonInteractive(names: string[]): TerminalSetupResult {
  const normalizedNames = normalizeTerminalInputs(names);
  if (normalizedNames.length === 0) {
    return { configuredAny: false, skipped: false };
  }

  if (isTerminalSetupSkipRequest(normalizedNames)) {
    console.log(
      chalk.dim(
        "  Tmux setup skipped by flag. Overwatch will use tmux sessions you create yourself.",
      ),
    );
    return { configuredAny: false, skipped: true };
  }

  if (!commandExists("tmux")) {
    console.log(
      chalk.yellow("  !") +
        " tmux is missing. Re-run the installer so it can provision tmux first.",
    );
    return { configuredAny: false, skipped: false };
  }

  const terminals = detectTerminals().filter((terminal) => terminal.name !== "cmux");
  let configuredAny = false;
  let selectedOnlyCmux = true;

  for (const terminalName of normalizedNames) {
    const normalized = normalizeTerminalName(terminalName);
    if (normalized === "cmux") {
      console.log(chalk.dim("  cmux selected - no terminal file edits needed."));
      continue;
    }
    selectedOnlyCmux = false;

    const terminal = terminals.find(
      (item) => normalizeTerminalName(item.name) === normalized,
    );
    if (!terminal) {
      throw new Error(
        `Unknown terminal "${terminalName}". Use one of: ghostty, kitty, alacritty, iterm2, cmux, none, existing-tmux.`,
      );
    }

    const result = configureTerminalByName(terminal.name, terminal.configPath);
    configuredAny = printTerminalConfigResult(result, false) || configuredAny;
  }

  return { configuredAny, skipped: selectedOnlyCmux && !configuredAny };
}

function configureTerminalByName(name: string, configPath: string): TerminalConfigResult {
  switch (name) {
    case "Ghostty":
      return configureTextTerminal(name, configPath, buildGhosttyConfig);
    case "Kitty":
      return configureTextTerminal(name, configPath, buildKittyConfig);
    case "Alacritty":
      return configureTextTerminal(name, configPath, buildAlacrittyConfig);
    case "iTerm2":
      return configureITerm2();
    default:
      return {
        terminal: name,
        status: "skipped",
        configPath,
        reason: "unsupported terminal",
      };
  }
}

function configureTextTerminal(
  terminal: string,
  configPath: string,
  buildEdit: (content: string, scriptPath: string) => TextConfigEdit,
): TerminalConfigResult {
  mkdirSync(dirname(configPath), { recursive: true });
  const content = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  const scriptPath = getTmuxScriptPath();
  const edit = buildEdit(content, scriptPath);

  if (edit.status === "skipped") {
    return {
      terminal,
      status: "skipped",
      configPath,
      reason: edit.reason,
    };
  }

  if (edit.status === "unchanged") {
    installManagedTmuxBootstrap();
    return {
      terminal,
      status: "unchanged",
      configPath,
      reason: edit.reason,
    };
  }

  installManagedTmuxBootstrap();
  backupFile(configPath);
  writeFileSync(configPath, edit.content, "utf-8");
  return { terminal, status: "configured", configPath };
}

function configureITerm2(): TerminalConfigResult {
  const plistPath = join(
    homedir(),
    "Library",
    "Preferences",
    "com.googlecode.iterm2.plist",
  );
  if (!existsSync(plistPath)) {
    return {
      terminal: "iTerm2",
      status: "skipped",
      configPath: plistPath,
      reason: "iTerm2 preferences file not found",
    };
  }

  try {
    const current = execSync(
      `/usr/libexec/PlistBuddy -c "Print :New\\ Bookmarks:0:Command" "${plistPath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (current.includes(OVERWATCH_SCRIPT_FRAGMENT)) {
      installManagedTmuxBootstrap();
      return {
        terminal: "iTerm2",
        status: "unchanged",
        configPath: plistPath,
        reason: "Overwatch auto-start is already present.",
      };
    }
    if (current) {
      return {
        terminal: "iTerm2",
        status: "skipped",
        configPath: plistPath,
        reason: "existing iTerm2 custom command would be overwritten",
      };
    }
  } catch {
    // Missing command is fine; the profile can still be configured below.
  }

  try {
    const scriptPath = installManagedTmuxBootstrap();
    execSync(
      `/usr/libexec/PlistBuddy -c "Set :New\\ Bookmarks:0:Custom\\ Command Yes" "${plistPath}"`,
      { stdio: "ignore" },
    );
    execSync(
      `/usr/libexec/PlistBuddy -c "Set :New\\ Bookmarks:0:Command ${scriptPath}" "${plistPath}"`,
      { stdio: "ignore" },
    );
    return { terminal: "iTerm2", status: "configured", configPath: plistPath };
  } catch {
    return {
      terminal: "iTerm2",
      status: "skipped",
      configPath: plistPath,
      reason: "could not update iTerm2 preferences",
    };
  }
}

function printTerminalConfigResult(
  result: TerminalConfigResult,
  includeBackup = true,
): boolean {
  if (result.status === "configured") {
    console.log(chalk.green("  OK") + ` Configured ${result.terminal}`);
    if (includeBackup && result.terminal !== "iTerm2" && result.configPath) {
      console.log(chalk.dim(`    Backup saved to ${result.configPath}.overwatch-backup`));
    }
    return true;
  }

  if (result.status === "unchanged") {
    console.log(chalk.dim(`  ${result.terminal} already configured`));
    return false;
  }

  const reason = result.reason ? ` - ${result.reason}` : "";
  console.log(chalk.yellow("  !") + ` Skipped ${result.terminal}${reason}`);
  return false;
}

function backupFile(path: string): string {
  const backup = `${path}.overwatch-backup`;
  if (!existsSync(backup) && existsSync(path)) {
    copyFileSync(path, backup);
  }
  return backup;
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

function appendManagedBlock(content: string, body: string): TextConfigEdit {
  const trimmed = content.trimEnd();
  const prefix = trimmed ? `${trimmed}\n\n` : "";
  return {
    status: "updated",
    content: `${prefix}${managedBlock(body)}`,
  };
}

function replaceManagedBlock(content: string, body: string): TextConfigEdit {
  const nextBlock = managedBlock(body);
  const pattern = new RegExp(
    `${escapeRegex(OVERWATCH_MARKER_START)}[\\s\\S]*?${escapeRegex(
      OVERWATCH_MARKER_END,
    )}\\n?`,
    "m",
  );
  const next = content.replace(pattern, nextBlock);
  if (next === content) {
    return {
      status: "unchanged",
      content,
      reason: "Overwatch auto-start is already present.",
    };
  }
  return { status: "updated", content: next };
}

function managedBlock(body: string): string {
  return `${OVERWATCH_MARKER_START}
${body.trimEnd()}
${OVERWATCH_MARKER_END}
`;
}

function hasOverwatchManagedBlock(content: string): boolean {
  return (
    content.includes(OVERWATCH_MARKER_START) &&
    content.includes(OVERWATCH_MARKER_END)
  );
}

function hasActiveLine(content: string, pattern: RegExp): boolean {
  return content
    .split("\n")
    .some((line) => !line.trimStart().startsWith("#") && pattern.test(line.trim()));
}

function hasAlacrittyShellSection(content: string): boolean {
  return /^\s*\[(?:terminal\.)?shell\]\s*$/m.test(content);
}

function ghosttyManagedBody(scriptPath: string): string {
  // Cmd+K relays to Ctrl+L (\\x0c), which our tmux config maps to clear +
  // clear-history. Ghostty's native cmd+k=clear_screen only acts on the
  // primary screen; tmux owns the alt screen, so we forward instead.
  // Source: github.com/ghostty-org/ghostty/discussions/3382.
  // clipboard-write = allow lets tmux's OSC52 selection-copy land in the
  // macOS pasteboard without a permission prompt.
  return [
    `command = ${scriptPath}`,
    "keybind = cmd+k=text:\\x0c",
    "clipboard-write = allow",
  ].join("\n");
}

function kittyManagedBody(scriptPath: string): string {
  return [
    `shell ${scriptPath}`,
    "map cmd+k send_text all \\x0c",
  ].join("\n");
}

function alacrittyManagedBody(scriptPath: string): string {
  return [
    "[terminal.shell]",
    `program = "${escapeTomlString(scriptPath)}"`,
    "",
    "[[keyboard.bindings]]",
    'key = "K"',
    'mods = "Command"',
    'chars = "\\u000c"',
  ].join("\n");
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAlacrittyConfig,
  buildGhosttyConfig,
  buildKittyConfig,
  createNativeFirstTmuxConfig,
  createTmuxSessionScript,
  isTerminalSetupSkipRequest,
} from "../packages/cli/src/terminal-setup.js";

test("native-first tmux config gives terminals capability + macOS-feel bindings", () => {
  const config = createNativeFirstTmuxConfig();

  for (const expected of [
    // Capability essentials.
    "set -g mouse on",
    "set -g history-limit 100000",
    "set -s set-clipboard on",
    "set -as terminal-features ',xterm-ghostty:RGB'",
    "set -as terminal-features ',xterm-kitty:RGB'",
    "set -g allow-passthrough on",
    "set -s extended-keys on",
    "set -s extended-keys-format csi-u",
    // Wheel passthrough for alt-screen apps (less / vim / man / TUIs).
    "bind -n WheelUpPane",
    "bind -n WheelDownPane",
    "alternate_on",
    // macOS-style readline relays.
    "bind -n Home send-key C-a",
    "bind -n End  send-key C-e",
    "bind -n M-BSpace send-key C-w",
    "bind -n M-Left",
    "bind -n M-Right",
    // Cmd+K equivalent: clear screen + scrollback.
    "bind -n C-l send-keys C-l",
    "clear-history",
    // Native-feel copy on selection.
    "bind -T copy-mode MouseDragEnd1Pane send -X copy-pipe-and-cancel",
    "bind -T copy-mode DoubleClick1Pane",
    "bind -T copy-mode TripleClick1Pane",
    // Word separators for predictable double-click selection.
    "set -g word-separators",
    // Visible status bar (minimal) so users see which session they're in.
    "set -g status on",
  ]) {
    assert.match(config, new RegExp(escapeRegex(expected)));
  }

  for (const forbidden of [
    // We keep the default C-b prefix so power users still have an escape hatch.
    "set -g prefix None",
    "unbind-key -q C-b",
    // Status bar stays visible so users see which tmux session they're in.
    "set -g status off",
  ]) {
    assert.doesNotMatch(config, new RegExp(escapeRegex(forbidden)));
  }
});

test("tmux session script starts a login shell inside managed sessions", () => {
  const script = createTmuxSessionScript();

  assert.match(script, /SHELL_CMD="\$\{SHELL:-\/bin\/zsh\} -l"/);
  assert.match(script, /tmux -f "\$CONF" new-session -s "\$n" "\$SHELL_CMD"/);
  assert.match(script, /tmux new-session -s "\$n" "\$SHELL_CMD"/);
});

test("terminal skip aliases include existing-tmux", () => {
  assert.equal(isTerminalSetupSkipRequest(["none"]), true);
  assert.equal(isTerminalSetupSkipRequest(["skip"]), true);
  assert.equal(isTerminalSetupSkipRequest(["existing-tmux"]), true);
  assert.equal(isTerminalSetupSkipRequest(["ghostty,existing-tmux"]), true);
  assert.equal(isTerminalSetupSkipRequest(["ghostty"]), false);
});

test("Ghostty config uses marker blocks, relays Cmd+K, and preserves existing commands", () => {
  const added = buildGhosttyConfig("font-size = 14\n", "/tmp/tmux-session.sh");
  assert.equal(added.status, "updated");
  assert.match(added.content, /# >>> overwatch tmux auto-start >>>/);
  assert.match(added.content, /command = \/tmp\/tmux-session\.sh/);
  assert.match(added.content, /keybind = cmd\+k=text:\\x0c/);
  assert.match(added.content, /clipboard-write = allow/);

  const skipped = buildGhosttyConfig("command = /bin/zsh\n", "/tmp/tmux-session.sh");
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.reason ?? "", /existing Ghostty command/);
});

test("Kitty config uses marker blocks, relays Cmd+K, and preserves existing shells", () => {
  const added = buildKittyConfig("font_size 14\n", "/tmp/tmux-session.sh");
  assert.equal(added.status, "updated");
  assert.match(added.content, /# >>> overwatch tmux auto-start >>>/);
  assert.match(added.content, /shell \/tmp\/tmux-session\.sh/);
  assert.match(added.content, /map cmd\+k send_text all \\x0c/);

  const skipped = buildKittyConfig("shell /bin/zsh\n", "/tmp/tmux-session.sh");
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.reason ?? "", /existing Kitty shell/);
});

test("Alacritty config uses marker blocks, relays Cmd+K, and preserves existing shell sections", () => {
  const added = buildAlacrittyConfig("[window]\nopacity = 1\n", "/tmp/tmux-session.sh");
  assert.equal(added.status, "updated");
  assert.match(added.content, /# >>> overwatch tmux auto-start >>>/);
  assert.match(added.content, /\[terminal\.shell\]\nprogram = "\/tmp\/tmux-session\.sh"/);
  assert.match(added.content, /\[\[keyboard\.bindings\]\]/);
  assert.match(added.content, /key = "K"/);
  assert.match(added.content, /mods = "Command"/);
  assert.match(added.content, /chars = "\\u000c"/);

  const skipped = buildAlacrittyConfig(
    "[terminal.shell]\nprogram = \"/bin/zsh\"\n",
    "/tmp/tmux-session.sh",
  );
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.reason ?? "", /existing Alacritty shell block/);
});

test("existing marker blocks update idempotently", () => {
  const content = [
    "font-size = 14",
    "",
    "# >>> overwatch tmux auto-start >>>",
    "command = /old/tmux-session.sh",
    "# <<< overwatch tmux auto-start <<<",
    "",
  ].join("\n");

  const updated = buildGhosttyConfig(content, "/new/tmux-session.sh");
  assert.equal(updated.status, "updated");
  assert.match(updated.content, /command = \/new\/tmux-session\.sh/);
  assert.doesNotMatch(updated.content, /\/old\/tmux-session\.sh/);
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

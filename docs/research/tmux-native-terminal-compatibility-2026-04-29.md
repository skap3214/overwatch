# Research: Native-First tmux Terminal Setup

**Date:** 2026-04-29
**Status:** Implemented
**Related Code:** `packages/cli/src/terminal-setup.ts`, `packages/cli/src/commands/setup.ts`
**Related Docs:** `../../AGENT_SETUP.md`, `../insights.md`

## Goal

Overwatch configures terminal auto-start so ordinary terminal tabs become tmux sessions that the app can discover and control. The setup should feel as close as possible to using the terminal without tmux, especially for users with custom terminal keybindings, trackpad habits, and click/selection expectations.

## Product Decision

Use two separate paths:

1. **Managed tmux for non-tmux users.** Overwatch owns a small native-first tmux profile that prioritizes terminal compatibility over tmux power-user conveniences.
2. **Explicit skip for existing tmux users.** Users who already have tmux config, active tmux sessions, or shell/terminal tmux autostart should keep their setup. Overwatch will observe and drive sessions they create themselves.

This avoids the impossible middle ground of satisfying opinionated tmux users with a generated config while also making first-run setup reliable for people who do not care about tmux.

## Native-First Managed Profile

Capability fixes that make tmux usable in modern terminals:

- `mouse on` for scrollback and pane clicks
- `history-limit 100000`
- `tmux-256color`, truecolor/RGB feature declarations
- OSC 52 clipboard support (`set-clipboard on`) so selections reach the system pasteboard with no shim
- styled underline support
- focus events
- OSC passthrough (kitty graphics, iTerm2 inline images)
- low escape-time for responsive Meta/Option sequences
- `extended-keys on` plus `extended-keys-format csi-u` for disambiguated Shift+Enter, Ctrl+Enter, Ctrl/Shift+letter, Tab vs Ctrl+I, Enter vs Ctrl+M — the format Ghostty / Kitty / iTerm2 natively emit and that pi-coding-agent expects

Native-feel additions, layered on top of the capability set so tmux behaves as close to the bare terminal as possible:

- **Wheel passthrough in alt-screen apps.** `bind -n WheelUpPane` / `WheelDownPane` use `#{alternate_on}` to forward the wheel as Up/Down arrow keys when running `less` / `man` / `vim` / `htop` / Claude TUI, so those apps scroll natively instead of popping tmux copy-mode over the alt screen. Verbatim from the [tmux wiki Recipes page](https://github.com/tmux/tmux/wiki/Recipes); see also tmux issues [#3705](https://github.com/tmux/tmux/issues/3705) and [#4952](https://github.com/tmux/tmux/issues/4952).
- **Smoother copy-mode wheel.** `send -X -N 3 scroll-up` (vs default 5) feels closer to Ghostty's pixel scroll.
- **macOS readline relays.** `Home → C-a`, `End → C-e`, `M-Left → M-b`, `M-Right → M-f`, `M-BSpace → C-w`, `M-DC → M-d`. These match the bindings the macOS terminal already emits and keep zsh's readline working inside tmux.
- **Cmd+K → clear screen + scrollback.** `bind -n C-l send-keys C-l \; clear-history` on the tmux side; matched per-terminal:
  - Ghostty: `keybind = cmd+k=text:\x0c` (verified via [Ghostty discussion #3382](https://github.com/ghostty-org/ghostty/discussions/3382))
  - Kitty: `map cmd+k send_text all \x0c`
  - Alacritty: `[[keyboard.bindings]]` with `key = "K"`, `mods = "Command"`, `chars = ""`
- **Drag-to-copy / double-click word / triple-click line / middle-click paste.** Matches macOS Terminal and iTerm2's "Copy on Selection" plus Linux X-style middle-click paste.
- **`word-separators`** set so double-click selects words the way macOS Terminal does, not greedily across paths/punctuation.
- **`clipboard-write = allow`** in the Ghostty managed block so OSC52 selection-copy reaches the macOS pasteboard without a permission prompt.
- **Visible minimal status bar** so users can see which tmux session number a fresh tab is in (each Ghostty tab → fresh session 0/1/2…), which Overwatch references when orchestrating panes.
- **Default `C-b` prefix retained** so power users still have an escape hatch to copy-mode search, pane splits, and other tmux commands. Most non-tmux users never hit it.

### Known caveat: claude-code-cli harness + multi-line paste

`extended-keys-format csi-u` triggers [anthropics/claude-code#43169](https://github.com/anthropics/claude-code/issues/43169): tmux re-encodes CR/LF inside bracketed paste as CSI-u, and Claude Code's paste tokenizer doesn't decode it, so multi-line pastes collapse to a single line. The bug is closed-as-duplicate of #3134 / #41598 with no confirmed fix in a shipped release.

We ship `csi-u` on anyway because the default `pi-coding-agent` harness explicitly recommends it, the keystroke disambiguation it provides is what makes Shift+Enter / Ctrl+Enter behave like users expect, and Overwatch is pre-release so there are no production users on the claude-code-cli harness to protect. Users who hit the paste regression on that harness can drop `set -s extended-keys-format xterm` into `~/.tmux.conf` (managed config sources it last).

The implemented profile sources `~/.tmux.conf` last if present, but setup prompts existing tmux users to skip before they reach this path.

## Mouse / Trackpad Tradeoff

tmux cannot perfectly preserve terminal-native mouse behavior when `mouse on` is enabled — wheel/click/drag events reach tmux first so its scrollback, pane focus, and copy bindings can work. The cost is that some terminal-native gestures (notably trackpad inertial scroll and the terminal's own selection layer) are replaced by tmux's. The wheel-passthrough recipe above eats most of the regression because alt-screen apps no longer pop tmux copy-mode on every wheel tick. Users can still hold Option (macOS) or Shift (Linux) to bypass tmux mouse mode entirely and use the terminal's native selection.

## Terminal Config Policy

Terminal config edits are marker-based:

```text
# >>> overwatch tmux auto-start >>>
...
# <<< overwatch tmux auto-start <<<
```

Setup can update its own block idempotently. It does not overwrite user-owned launch commands by default:

- Ghostty: skip if an existing active `command = ...` is present.
- Kitty: skip if an existing active `shell ...` is present.
- Alacritty: skip if `[terminal.shell]` or `[shell]` already exists.
- iTerm2: skip if the default profile already has a custom command.

This preserves custom terminal setup and avoids breaking users who already customized startup behavior.

## Open Validation

Local non-GUI validation on the maintainer machine passed with:

- Ghostty 1.3.1: generated config passed `ghostty +validate-config --config-file`.
- Kitty 0.45.0: generated config parsed with Kitty's bundled `kitty.config.load_config`.
- Alacritty 0.17.0: generated config passed `alacritty migrate --dry-run --config-file`.
- iTerm2: the exact `PlistBuddy` commands used by setup worked against a temporary copy of `com.googlecode.iterm2.plist`.
- tmux 3.6a: generated tmux config parsed on an isolated tmux socket.
- Bootstrap script: a fake-`tmux` harness verified that it calls `tmux new-session` with the generated config and a login shell command.

Remaining validation requires GUI/manual checks in each terminal: actual trackpad scrolling inside `less` / `man` / `vim` (should now scroll natively thanks to the wheel-passthrough recipe), Cmd+K clearing scrollback through the relay, native text-selection bypass via Option (macOS), and OSC52 copy reaching the system pasteboard without a permission prompt.

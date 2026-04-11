---
name: opencode
description: >-
  How to control OpenCode CLI sessions running in tmux panes. Covers
  permission dialogs, leader-key system, key bindings, agents, input
  submission, state detection, and tmux send-keys patterns. Use when
  orchestrating or interacting with an OpenCode session.
---

# OpenCode CLI — tmux Control Reference

## Launching

```bash
# Standard interactive session
opencode

# With initial prompt
opencode --prompt "your task"

# Specify model (provider/model format)
opencode -m anthropic/claude-sonnet-4-5

# Continue last session
opencode --continue
# or
opencode -c

# Resume specific session
opencode --session <id>

# Set project directory
opencode /path/to/project
```

## Sending Prompts via tmux

OpenCode accepts standard send-keys input. Enter submits.

```bash
# Send a prompt and submit
tmux send-keys -t <pane> "your prompt text here" Enter

# Multi-line (Ctrl+J for newline — Shift+Enter does NOT work in tmux)
tmux send-keys -t <pane> "first line" C-j "second line" Enter
```

Shift+Enter sends the same byte sequence as Enter in tmux, so it submits instead of adding a newline. Always use Ctrl+J for newlines.

## Permission Prompts

### Permission Levels

| Level | Behavior |
|-------|----------|
| `allow` | Executes automatically, no prompt |
| `ask` | Modal dialog blocks all input until user responds |
| `deny` | Blocked entirely |

### Responding to Permission Dialogs

When a permission dialog appears, it shows three options: Allow / Always / Deny.

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Allow once | `a` | `tmux send-keys -t <pane> "a"` |
| Allow for session | `A` (Shift+A) | `tmux send-keys -t <pane> "A"` |
| Deny | `d` | `tmux send-keys -t <pane> "d"` |
| Navigate options | Left/Right/Tab | `Left` / `Right` / `Tab` |
| Confirm highlighted | Enter or Space | `Enter` or `Space` |

TIP: Use Left/Right arrow keys or Tab to navigate and read the available options before confirming. This helps you understand what each choice does (e.g. "allow once" vs "allow for session" vs "deny") rather than blindly confirming.

### Question Prompts (Agent Asks User)

When the agent asks a question with numbered options:

```bash
# Select option 1
tmux send-keys -t <pane> "1" Enter

# Select option 2
tmux send-keys -t <pane> "2" Enter
```

### Configuring Permissions in opencode.json

```json
{
  "permission": {
    "*": "ask",
    "bash": {
      "*": "ask",
      "git *": "allow",
      "rm *": "deny"
    },
    "edit": "allow",
    "read": {
      "*": "allow",
      "*.env": "deny"
    }
  }
}
```

For automation, set all to allow:
```json
{ "permission": { "*": "allow" } }
```

### Non-Interactive Mode

```bash
# Skip all permission prompts
opencode run --dangerously-skip-permissions "your prompt"

# Standard non-interactive (will hang if any permission is "ask")
opencode run "your prompt"
```

IMPORTANT: In non-interactive and headless modes, `ask` permissions cause the session to hang indefinitely. Set permissions to `allow` or `deny` only.

## Key Bindings

### Leader Key System

The default leader key is **Ctrl+X**. Press Ctrl+X, release, then press the second key. This avoids conflict with tmux's Ctrl+B prefix.

```bash
# Example: new session = Ctrl+X then n
tmux send-keys -t <pane> C-x n
```

### Application / Global

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Exit | Ctrl+C, Ctrl+D | `C-c` or `C-d` |
| Command palette | Ctrl+P | `C-p` |
| External editor | Leader + e | `C-x e` |
| Toggle sidebar | Leader + b | `C-x b` |
| View status | Leader + s | `C-x s` |

### Session Management

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| New session | Leader + n | `C-x n` |
| Session list | Leader + l | `C-x l` |
| Compact session | Leader + c | `C-x c` |
| Cancel/interrupt | Escape | `Escape` |
| Export session | Leader + x | `C-x x` |

### Model and Agent

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Model list | Leader + m | `C-x m` |
| Cycle recent models | F2 | `F2` |
| Cycle agents (Build/Plan) | Tab | `Tab` |
| Cycle agents reverse | Shift+Tab | `BTab` |
| Agent list | Leader + a | `C-x a` |

### Message Navigation

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Scroll to top | Ctrl+G or Home | `C-g` or `Home` |
| Scroll to bottom | End | `End` |
| Page up/down | PageUp / PageDown | `PageUp` / `PageDown` |
| Copy message | Leader + y | `C-x y` |
| Undo message | Leader + u | `C-x u` |

### Input Field

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Submit | Enter | `Enter` |
| Newline | Ctrl+J | `C-j` |
| Clear input | Ctrl+C | `C-c` |
| Start of line | Ctrl+A | `C-a` |
| End of line | Ctrl+E | `C-e` |
| Delete to end | Ctrl+K | `C-k` |
| Delete to start | Ctrl+U | `C-u` |
| Delete word back | Ctrl+W | `C-w` |

## Special Input Prefixes

| Prefix | Effect |
|--------|--------|
| `!` | Shell mode — execute bash command directly |
| `@` | File autocomplete / fuzzy search |
| `/` | Slash command autocomplete |

## Agents (Build vs Plan)

| Agent | Purpose | Tools |
|-------|---------|-------|
| Build (default) | Full development — reads, edits, commands | All enabled |
| Plan | Read-only analysis | File edits and bash disabled or set to ask |

Switch with Tab key: `tmux send-keys -t <pane> Tab`

## State Detection

```bash
tmux capture-pane -t <pane> -p -S -50
```

| State | Indicators |
|-------|-----------|
| Idle / ready | Input area visible with cursor |
| Busy / thinking | Spinner animation in status gutter |
| Permission dialog | Modal dialog visible with Allow/Deny options |
| Question prompt | Numbered options displayed |
| Tool executing | Output streaming in conversation area |

## Configuration

### File Locations (precedence, highest to lowest)

1. CLI flags
2. `OPENCODE_CONFIG_CONTENT` env var
3. Project: `./opencode.json`
4. Global: `~/.config/opencode/opencode.json`

### TUI Config (separate)

Global: `~/.config/opencode/tui.json`
Project: `./tui.json`

Keybindings are customized in `tui.json`:
```json
{
  "keybinds": {
    "input_submit": "return",
    "input_newline": "shift+return,ctrl+j",
    "leader": "ctrl+x"
  }
}
```

### Key Config

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "permission": { "*": "allow" },
  "compaction": { "auto": true },
  "tools": { "bash": true, "edit": true }
}
```

## Authentication

```bash
# Inside TUI
/connect

# CLI auth commands
opencode auth login
opencode auth list
opencode auth logout

# Or set environment variables
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
```

## Installation

```bash
# Install script
curl -fsSL https://opencode.ai/install | bash

# Homebrew
brew install opencode-ai/tap/opencode

# npm
npm install -g opencode

# Go
go install github.com/opencode-ai/opencode@latest
```

## Server Mode (Alternative to tmux)

For robust programmatic control without tmux quirks:

```bash
# Start headless server
opencode serve --port 4096

# Send prompts via HTTP
POST http://localhost:4096/session/:id/message

# Respond to permissions via HTTP
POST http://localhost:4096/session/:id/permissions/:permissionID
  { "response": "allow", "remember": true }

# Real-time events
GET http://localhost:4096/event  (SSE stream)
```

Note: In server mode, `ask` permissions cause hangs. Set to `allow` or `deny` only, or handle permission API calls programmatically.

## tmux Quirks

1. **Shift+Enter does not work** — sends same byte as Enter. Use Ctrl+J for newlines.
2. **Leader key (Ctrl+X) does not conflict** with tmux prefix (Ctrl+B) by default.
3. **Extended keys** — some Ctrl+punctuation combos need tmux 3.5+ with `set -g extended-keys on`.
4. **tmux 3.6+** may show hex codes in prompt area on startup (keyboard protocol issue).
5. **TUI redraws** can cause flickering in tmux.

## Tips for Orchestration

1. Set `"permission": { "*": "allow" }` in opencode.json to eliminate interactive prompts.
2. Use Ctrl+J (not Shift+Enter) for multi-line input in tmux.
3. For approval prompts, send `a` (allow once) or `A` (allow for session).
4. For question prompts, send the option number then Enter.
5. Use `opencode run --dangerously-skip-permissions` for non-interactive automation.
6. Consider server mode (`opencode serve`) for the most reliable programmatic control.
7. Use Tab to switch between Build (full tools) and Plan (read-only) agents.

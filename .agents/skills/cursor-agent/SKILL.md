---
name: cursor-agent
description: >-
  How to control Cursor Agent CLI sessions running in tmux panes. Covers
  permission prompts, approval modes, key bindings, input submission,
  state detection, and tmux send-keys patterns. Use when orchestrating
  or interacting with a Cursor Agent session.
---

# Cursor Agent CLI — tmux Control Reference

## Overview

Cursor Agent CLI is a standalone terminal tool (binary name: `agent`). It requires a Cursor subscription (Pro/Business). Currently in beta.

## Launching

```bash
# Standard interactive session
agent "your task description"

# Force mode — auto-approve commands (essential for automation)
agent --force "your task"
# Alias:
agent --yolo "your task"

# Specify model
agent --model claude-sonnet-4-5 "your task"

# Set working directory
agent --workspace /path/to/project

# Trust workspace without prompting (for headless/automation)
agent --trust "your task"

# Full automation launch
agent --yolo --trust "your task"

# Plan mode (no code changes, just strategy)
agent --plan "your task"

# Ask mode (read-only exploration)
agent --mode ask "your task"

# Non-interactive mode
agent -p "your task" --output-format json

# Continue last session
agent --continue

# Resume specific session
agent --resume <chatId>

# Run in isolated git worktree
agent --worktree "your task"

# Cloud handoff
agent -c "your task"
```

## Sending Prompts via tmux — IMPORTANT QUIRK

Cursor Agent requires the same TWO-STEP send-keys pattern as Codex. A plain `send-keys "text" Enter` inserts a newline into the input instead of submitting on the first Enter.

```bash
# Step 1: Send text in LITERAL mode (-l flag)
tmux send-keys -t <pane> -l "your prompt text here"

# Step 2: Brief delay
sleep 0.2

# Step 3: Send Enter SEPARATELY (not literal)
tmux send-keys -t <pane> Enter
```

This is the ONLY reliable pattern. Without `-l`, the first Enter adds a newline in the composer instead of submitting.

### Multi-line Input

```bash
# Use Ctrl+J between lines
tmux send-keys -t <pane> -l "first line"
tmux send-keys -t <pane> C-j
tmux send-keys -t <pane> -l "second line"
sleep 0.2
tmux send-keys -t <pane> Enter
```

Shift+Enter does NOT work in tmux — use Ctrl+J for newlines.

## Permission / Approval System

### Interactive Mode (default)

The CLI asks for approval before running shell commands. User responds:

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Approve | `y` | `tmux send-keys -t <pane> "y"` |
| Reject | `n` | `tmux send-keys -t <pane> "n"` |

TIP: Some approval dialogs use arrow-key selectors instead of y/n. Use Up/Down arrows to navigate and read the available options before pressing Enter to confirm. This helps you understand what each choice does rather than blindly accepting.

### Force / YOLO Mode

`--force` or `--yolo` auto-approves commands unless explicitly in the deny list. This is the recommended mode for automation.

### Workspace Trust

On first run in a new workspace, Cursor prompts to trust it. For automation:
- Use `--trust` flag at launch
- Or send `a` keystroke after a brief delay:

```bash
tmux send-keys -t <pane> "agent 'your task'" Enter
sleep 3
tmux send-keys -t <pane> "a"   # approve workspace trust
```

### Permission Config

Global: `~/.cursor/cli-config.json`
Project: `<project>/.cursor/cli.json`

```json
{
  "permissions": {
    "allow": ["Shell(npm:*)", "Shell(git:*)"],
    "deny": ["Shell(rm:-rf)"]
  }
}
```

Permission types:
- `Shell(commandBase)` — shell commands (glob patterns)
- `Read(pathOrGlob)` — file read access
- `Write(pathOrGlob)` — file write access
- `WebFetch(domainOrPattern)` — web access
- `Mcp(server:tool)` — MCP tool execution

Deny rules take precedence over allow rules.

## Key Bindings

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Submit prompt | Enter | `Enter` |
| Newline (not submit) | Ctrl+J | `C-j` |
| Cycle modes (agent/plan/ask) | Shift+Tab | `BTab` |
| Review changes | Ctrl+R | `C-r` |
| Exit | Ctrl+D (double-press) | `C-d C-d` |
| Message history | Up arrow | `Up` |

## Operating Modes

| Mode | Purpose | Activation |
|------|---------|------------|
| Agent | Full tool access (default) | Default or `--mode agent` |
| Plan | Strategy, clarifying questions, no code changes | `BTab` or `--plan` |
| Ask | Read-only exploration | `--mode ask` |

Switch modes interactively:
```bash
tmux send-keys -t <pane> BTab   # cycles: agent → plan → ask
```

## State Detection

```bash
tmux capture-pane -t <pane> -p -S -50
```

| State | Indicators |
|-------|-----------|
| Thinking / generating | "Planning next moves" with spinner |
| Long operation | "Taking longer than expected" after ~30-60s |
| Waiting for approval | y/n prompt visible |
| Idle / ready | Input area with cursor |

The TUI uses box-drawing characters. When parsing `tmux capture-pane` output, filter out lines with UI chrome (box-drawing chars like `|`), "INSERT", "Add a follow-up" text.

## Non-Interactive Mode

```bash
# Plain text output
agent -p "your task" --output-format text

# JSON output
agent -p "your task" --output-format json

# Streaming NDJSON events
agent -p "your task" --output-format stream-json --stream-partial-output

# Force approve + trust for full automation
agent -p --force --trust "your task"
```

Note: `-p` mode still gates file writes unless `--force` is also passed.

## Cloud Handoff

Push any conversation to Cursor's cloud infrastructure:

```bash
# Prefix message with &
tmux send-keys -t <pane> -l "&your task for cloud"
sleep 0.2
tmux send-keys -t <pane> Enter

# Or launch with cloud flag
agent -c "your task"
```

Monitor cloud agents at cursor.com/agents.

## Configuration

Config at `~/.cursor/cli-config.json`:

```json
{
  "version": 1,
  "permissions": {
    "allow": ["Shell(npm:*)"],
    "deny": ["Shell(rm:-rf)"]
  },
  "model": "claude-sonnet-4-5"
}
```

### Rules Files

Cursor Agent automatically loads:
- `.cursor/rules/` directory
- `AGENTS.md` in project root
- `CLAUDE.md` in project root

### MCP

Reads `mcp.json` for MCP server config. Manage with:
```bash
agent mcp list
agent mcp enable <server>
agent mcp disable <server>
```

Auto-approve all MCP servers: `--approve-mcps`

## Authentication

```bash
# Browser OAuth (recommended)
agent login

# API key (for CI/automation)
export CURSOR_API_KEY="your-key"
# or
agent --api-key <key> "your task"

# Check status
agent status
# or
agent whoami

# Logout
agent logout
```

Generate API keys at Cursor Dashboard under Cloud Agents -> User API Keys.

## Installation

```bash
# macOS/Linux
curl https://cursor.com/install -fsS | bash

# Homebrew
brew install --cask cursor-cli

# Binary goes to ~/.local/bin/ (must be on PATH)
```

Auto-updates by default. Manual update: `agent update`

## tmux Interaction Notes

1. **Requires a real TTY** — subprocess execution (spawn, exec) hangs. tmux provides the needed pseudo-terminal.
2. **Newlines**: Use Ctrl+J, not Shift+Enter.
3. **Window resize** causes entire chat history to scroll (~5 seconds). Avoid resizing during operation.
4. **TUI rendering**: Full TUI with box-drawing characters. `tmux capture-pane` includes UI chrome that needs filtering.
5. **For CI/automation**: Use `-p` mode with `--output-format json` or `stream-json` for clean parseable output.
6. **Python REPL quirk**: Set `PYTHON_BASIC_REPL=1` to prevent enhanced console from interfering with send-keys.

## Tips for Orchestration

1. Launch with `--yolo --trust` for automation with minimal prompts.
2. Use Ctrl+J (not Shift+Enter) for multi-line input in tmux.
3. For approval prompts, send `y` to approve or `n` to reject.
4. Handle workspace trust by including `--trust` flag or sending `a` after launch delay.
5. For fully scripted pipelines, use `-p --force --output-format stream-json`.
6. Use Shift+Tab (`BTab`) to cycle between agent/plan/ask modes.
7. Monitor with `tmux capture-pane -t <pane> -p` and filter UI chrome.

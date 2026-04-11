---
name: claude-code
description: >-
  How to control Claude Code CLI sessions running in tmux panes. Covers
  permission prompts, key bindings, slash commands, input submission,
  state detection, and tmux send-keys patterns. Use when orchestrating
  or interacting with a Claude Code session.
---

# Claude Code CLI — tmux Control Reference

## Launching

```bash
# Standard interactive session
claude

# With pre-approved tools (reduces permission prompts)
claude --allowedTools "Bash(git:*) Edit Read Write Glob Grep"

# Accept-edits mode (auto-approves file edits)
claude --permission-mode acceptEdits

# Full bypass (only if user explicitly opted in)
claude --dangerously-skip-permissions

# Non-interactive one-shot (avoids TUI entirely)
claude -p "prompt" --output-format stream-json --allowedTools "Bash Edit Read"

# Continue last conversation
claude --continue

# Resume specific session
claude --resume <session_id>
```

## Sending Prompts via tmux

Claude Code accepts input normally via send-keys — no literal mode needed.

```bash
# Send a prompt and submit
tmux send-keys -t <pane> "your prompt text here" Enter

# Multi-line input (backslash-enter is most reliable in tmux)
tmux send-keys -t <pane> "first line\\" Enter "second line" Enter

# Multi-line via Ctrl+J
tmux send-keys -t <pane> "first line" C-j "second line" Enter
```

Shift+Enter does NOT reliably work in tmux for newlines. Use `\` + Enter or Ctrl+J.

## Permission Prompts

Most users run Claude Code WITHOUT `--dangerously-skip-permissions`. The agent shows permission dialogs before executing tools like Bash commands and file writes.

### Accepting / Rejecting

The permission dialog shows a NUMBERED LIST with a cursor (`❯`). The first option ("Yes") is pre-selected. Example:

```
Do you want to create file.txt?
❯ 1. Yes
  2. Yes, allow all edits in src/ during this session (shift+tab)
  3. No
```

| Action | tmux send-keys |
|--------|---------------|
| Accept (confirm highlighted option) | `tmux send-keys -t <pane> Enter` |
| Move to next option | `tmux send-keys -t <pane> Down` or `tmux send-keys -t <pane> Tab` |
| Move to previous option | `tmux send-keys -t <pane> Up` |
| Cancel | `tmux send-keys -t <pane> Escape` |
| Cycle permission mode | `tmux send-keys -t <pane> BTab` (Shift+Tab) |

IMPORTANT: Do NOT send `y` or `n` — the dialog uses a selector, not y/n input. Just send `Enter` to accept the pre-selected first option.

TIP: Use Up/Down arrow keys to navigate the options and read what each one does before pressing Enter. This is useful when you want to understand the available choices (e.g. "allow once" vs "allow for session" vs "deny") rather than blindly accepting the first option.

### Permission Modes (cycle with Shift+Tab)

| Mode | Auto-approves |
|------|--------------|
| `default` | Reads only |
| `acceptEdits` | Reads + file edits + basic file ops (mkdir, touch, rm, mv, cp, sed) |
| `plan` | Reads only, no edits allowed at all |
| `bypassPermissions` | Everything (must be enabled at startup with `--allow-dangerously-skip-permissions`) |

### Pre-approving Tools

Reduce prompts by pre-approving via CLI flags:
```bash
claude --allowedTools "Bash(npm run *) Bash(git:*) Edit Read Write"
```

Or in `.claude/settings.json`:
```json
{
  "permissions": {
    "allow": ["Bash(npm run lint)", "Bash(git:*)"],
    "deny": ["Bash(curl *)"]
  }
}
```

Deny rules always take precedence over allow rules.

## Key Bindings

### General Controls

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Cancel/interrupt | Ctrl+C | `C-c` |
| Exit | Ctrl+D | `C-d` |
| Clear input | Ctrl+L | `C-l` |
| Toggle transcript | Ctrl+O | `C-o` |
| Toggle task list | Ctrl+T | `C-t` |
| Switch model | Alt+P | `M-p` |
| Toggle thinking | Alt+T | `M-t` |
| Toggle fast mode | Alt+O | `M-o` |
| Rewind (undo) | Esc Esc (double) | `Escape Escape` |
| Search history | Ctrl+R | `C-r` |

### Ctrl+B Conflict with tmux

Claude Code uses Ctrl+B to background tasks. This conflicts with tmux's default prefix key. To send Ctrl+B to Claude Code inside tmux, press Ctrl+B twice:
```bash
tmux send-keys -t <pane> C-b C-b
```

## Slash Commands

Send these as normal text input:

| Command | Purpose |
|---------|---------|
| `/clear` | Clear conversation (aliases: `/reset`, `/new`) |
| `/compact` | Compact conversation to save context |
| `/model sonnet` | Switch model |
| `/exit` | Exit Claude Code |
| `/help` | Show help |
| `/diff` | Show diff of changes |
| `/cost` | Show token usage |
| `/status` | Show version, model, account |
| `/plan` | Enter plan mode |
| `/context` | Show context usage |
| `/resume` | Resume a session |

```bash
tmux send-keys -t <pane> "/compact" Enter
tmux send-keys -t <pane> "/model opus" Enter
```

## Special Input Prefixes

| Prefix | Effect |
|--------|--------|
| `!` | Bash mode — runs command directly without Claude |
| `/` | Slash command |
| `@` | File path autocomplete |

## State Detection

Capture pane output to determine what Claude Code is doing:

```bash
tmux capture-pane -t <pane> -p -S -50
```

| State | How to detect |
|-------|--------------|
| Waiting for input | Prompt bar visible with cursor |
| Generating | Text streaming, tool names visible |
| Permission prompt | Dialog with Y/N options, tool name shown |
| Tool executing | Bash output streaming, spinner |
| Idle after response | Prompt bar reappears |

## Non-Interactive Mode

For scripted one-shot tasks, avoid the TUI entirely:

```bash
# Simple text output
claude -p "explain this file" --allowedTools "Read"

# Streaming JSON events
claude -p "fix the tests" --output-format stream-json --allowedTools "Bash Edit Read"

# Continue conversation non-interactively
claude -p "now run the tests" --continue --output-format stream-json

# With budget limit
claude -p "refactor this" --max-budget-usd 1.00 --allowedTools "Edit Read"
```

## Configuration Files

| Path | Purpose |
|------|---------|
| `CLAUDE.md` | Project instructions (committed) |
| `.claude/settings.json` | Project settings + permissions (committed) |
| `.claude/settings.local.json` | Local overrides (not committed) |
| `~/.claude/CLAUDE.md` | Global user instructions |
| `~/.claude/settings.json` | Global user settings |

## Tips for Orchestration

1. Start sessions with `--permission-mode acceptEdits` to minimize prompts for file changes.
2. Use `--allowedTools` to pre-approve expected tools and reduce interactive prompts.
3. For fully automated pipelines, use `-p` (print mode) with `--output-format stream-json`.
4. When a permission prompt appears, the first option ("Yes") is pre-selected — just send `Enter` to accept. Do NOT send `y`.
5. Use `/compact` periodically to manage context window in long sessions.
6. Monitor with `tmux capture-pane -t <pane> -p` to detect state and react.

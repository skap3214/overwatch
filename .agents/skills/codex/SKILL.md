---
name: codex
description: >-
  How to control OpenAI Codex CLI sessions running in tmux panes. Covers
  approval prompts, key bindings, input submission quirks (literal mode
  required), state detection, and tmux send-keys patterns. Use when
  orchestrating or interacting with a Codex session.
---

# OpenAI Codex CLI — tmux Control Reference

## Launching

```bash
# Standard interactive session
codex

# With initial prompt
codex "your task description"

# Full-auto mode (minimal approval prompts, sandboxed)
codex --full-auto "your task"

# Bypass all approvals (only in externally sandboxed environments)
codex --dangerously-bypass-approvals-and-sandbox "your task"
# Alias:
codex --yolo "your task"

# Specify model
codex -m o3 "your task"

# Set working directory
codex -C /path/to/project

# Disable alternate screen (helps tmux capture-pane)
codex --no-alt-screen
```

## Sending Prompts via tmux — CRITICAL QUIRK

Codex requires a TWO-STEP send-keys pattern. A single `send-keys "text" Enter` does NOT work — it inserts a newline inside the prompt instead of submitting.

```bash
# Step 1: Send text in LITERAL mode (-l flag)
tmux send-keys -t <pane> -l "your prompt text here"

# Step 2: Brief delay
sleep 0.2

# Step 3: Send Enter SEPARATELY (not literal)
tmux send-keys -t <pane> Enter
```

This is the ONLY reliable pattern. The `-l` flag prevents special character interpretation, and `Enter` must be a separate non-literal call.

### Multi-line Input

```bash
# Use Ctrl+J between lines
tmux send-keys -t <pane> -l "first line"
tmux send-keys -t <pane> C-j
tmux send-keys -t <pane> -l "second line"
sleep 0.2
tmux send-keys -t <pane> Enter
```

### Known tmux Issue: Enter Key Becomes Unresponsive

Codex uses the kitty keyboard protocol, which has limited tmux support. After a model turn completes or after pressing Escape, the Enter key can stop working entirely. If this happens:

1. Try: `tmux send-keys -t <pane> C-c` then retry
2. If that fails, restart the Codex session

## Approval Prompts

### Approval Modes

| Mode | Flag | Behavior |
|------|------|----------|
| Untrusted | `-a untrusted` | Most restrictive — only trusted commands (ls, cat) run without approval |
| On-request (default) | `-a on-request` | Agent decides when to ask; most in-scope ops run freely |
| Never | `-a never` | No approval prompts at all |

### Approval Dialog — Two UI Patterns

**Pattern A: Letter-key shortcuts**

| Key | Action |
|-----|--------|
| `a` | Accept once |
| `s` | Accept for session |
| `p` | Accept and add to policy |
| `d` | Decline |
| `c` | Cancel entire turn |

**Pattern B: Arrow-key menu (Ratatui overlays)**

A list with `>` indicator appears. The FIRST option is always pre-selected and is always the approval/accept option. Just press Enter to approve.

Detection strings for pattern B:
- `"Yes, just this once"`
- `"Yes, continue"`
- `"Yes, and don't ask"`
- `"Run the tool and continue"`

### Approving via tmux (safest universal approach)

```bash
# Enter confirms the pre-selected first option (always approve)
tmux send-keys -t <pane> Enter
```

This works for BOTH pattern A (if cursor is on accept) and pattern B (first option pre-selected).

For explicit letter-key approval:
```bash
tmux send-keys -t <pane> "a"   # accept once
tmux send-keys -t <pane> "s"   # accept for session
tmux send-keys -t <pane> "d"   # decline
```

TIP: For arrow-key menu dialogs, use Up/Down arrows to navigate and read the available options before pressing Enter. This helps you understand what each choice does (e.g. "Yes, just this once" vs "Yes, and don't ask") rather than blindly confirming the first option.

### Bypassing Approvals

For automation, launch with:
```bash
codex --full-auto "your task"
# or
codex --dangerously-bypass-approvals-and-sandbox "your task"
```

### Permission Config Files

- Global: `~/.codex/config.toml`
- Project: `.codex/config.toml`

## Key Bindings

### Input Composer

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Submit | Enter | `Enter` (separate from text!) |
| Newline (no submit) | Ctrl+J | `C-j` |
| Open external editor | Ctrl+G | `C-g` |
| Clear line | Ctrl+U | `C-u` |
| Delete word backward | Ctrl+W | `C-w` |
| Draft history up/down | Up / Down | `Up` / `Down` |
| File search | `@` | (type `@` in input) |
| Shell command | `!` prefix | (type `!` in input) |

### Session Controls

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Cancel / interrupt | Ctrl+C or Escape | `C-c` or `Escape` |
| Exit (empty prompt) | Ctrl+D | `C-d` |
| Clear screen | Ctrl+L | `C-l` |
| Copy last response | Ctrl+O | `C-o` |
| Command palette | Ctrl+P | `C-p` |
| Edit previous message | Esc Esc (double) | `Escape Escape` |

### While Agent Is Running

| Action | Key | tmux send-keys |
|--------|-----|---------------|
| Inject instructions mid-turn | Enter | `Enter` |
| Queue follow-up for next turn | Tab | `Tab` |
| Stop generation | Escape | `Escape` |

## Slash Commands

```bash
tmux send-keys -t <pane> -l "/model"
sleep 0.2
tmux send-keys -t <pane> Enter
```

| Command | Purpose |
|---------|---------|
| `/model` | Change model |
| `/clear` or `/new` | Clear conversation |
| `/compact` | Compact context |
| `/plan` | Enter plan mode |
| `/permissions` | Manage permissions |
| `/diff` | Show diffs |
| `/status` | Show status |
| `/resume` | Resume session |
| `/init` | Generate AGENTS.md |
| `/quit` or `/exit` | Exit |

## State Detection

```bash
tmux capture-pane -t <pane> -p -S -50
```

### Detecting Approval Prompts

Check for BOTH a primary AND secondary signal:

Primary signals (question text):
- `"Would you like to run"`
- `"Would you like to make"`
- `"Allow Codex to"`
- `"Do you trust the contents"`

Secondary signals (option text):
- `"Yes, just this once"`
- `"Yes, continue"`
- `"Yes, and don't ask"`
- `"Run the tool and continue"`

Add a 2-second cooldown between approvals per pane to prevent double-approvals.

## AGENTS.md

Codex reads `AGENTS.md` files for project instructions. Discovery order:
1. Global: `~/.codex/AGENTS.override.md` or `~/.codex/AGENTS.md`
2. Project: Walk from git root to cwd, checking each directory
3. Files concatenated; later overrides earlier
4. Max combined size: 32 KiB

Generate with `/init` slash command.

## Non-Interactive Mode

For scripted tasks without TUI:

```bash
# One-shot execution
codex exec --full-auto --json "your prompt" 2>/dev/null

# Pipe input
echo "data" | codex exec "analyze this"

# Output to file
codex exec -o result.txt "generate a config file"
```

## Configuration

Config at `~/.codex/config.toml`:

```toml
model = "o3"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[tui]
alternate_screen = "auto"
```

## Authentication

```bash
# Browser OAuth (default)
codex login

# API key via stdin
codex login --with-api-key

# Device code flow (headless)
codex login --device-auth

# Or set environment variable
export OPENAI_API_KEY="sk-..."
```

Credentials stored in `~/.codex/auth.json`.

## Tips for Orchestration

1. ALWAYS use the two-step send-keys pattern: `-l "text"` then separate `Enter`.
2. Use `--full-auto` or `--dangerously-bypass-approvals-and-sandbox` to minimize interactive prompts.
3. Use `--no-alt-screen` for better `tmux capture-pane` compatibility.
4. Poll `tmux capture-pane` to detect approval prompts and send `Enter` to approve.
5. If Enter stops working (kitty protocol bug), send `C-c` and retry.
6. For fully automated pipelines, prefer `codex exec` (non-interactive) over TUI.

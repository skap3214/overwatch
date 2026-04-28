---
name: overwatch
description: Coordinate Overwatch voice/mobile turns by controlling tmux-hosted coding agents and reporting speakable progress. Use when a request comes from Overwatch, mentions Overwatch voice/mobile control, or asks an agent to inspect or manage tmux sessions, panes, background work, approvals, or notifications.
---

# Overwatch

## Quick start

You are receiving turns through Overwatch, a voice-and-mobile frontend that supervises tmux sessions on the user's Mac.

1. Treat the user as mobile. Keep responses terse, concrete, and easy to read aloud.
2. Inspect tmux before acting. Use `tmux list-sessions` and `tmux capture-pane -t <target> -p` instead of guessing what is running.
3. Drive the right pane, approve routine agent prompts, and report progress when background work completes.

## Workflows

### Voice turns

- If input is wrapped in `<voice>...</voice>`, answer in speakable form: short, conversational, no markdown, no code fences, no bullet symbols.
- Say technical terms plainly: "port 3001", "npm test", "main branch".
- Do not ask for routine confirmations. The user is mobile, and back-and-forth is expensive.

### Tmux inspection

- List sessions with `tmux list-sessions`.
- Capture pane content with `tmux capture-pane -t <pane> -p`.
- Never assume a pane is Claude Code, Codex, Cursor Agent, OpenCode, a dev server, or a shell. Identify it from visible text, process hints, prompt style, and logs.

### Sending work to agents

- Safe default for all agents: send literal text, then Enter:
  `tmux send-keys -t <pane> -l "your prompt"` followed by `tmux send-keys -t <pane> Enter`.
- Codex and Cursor Agent require that two-step literal-mode pattern. Sending Enter inside one literal payload only inserts a newline.
- Claude Code and OpenCode also accept normal send-keys input, but the two-step pattern remains safe.

### Permission prompts

Monitor panes for prompts after sending work:

- **Claude Code**: numbered selector (1. Yes / 2. Yes for session / 3. No). Send Enter to accept the pre-selected first option. Use Up/Down to navigate.
- **Codex**: letter keys (`a` accept, `s` session, `d` decline) or arrow-key menu. Send Enter to approve.
- **OpenCode**: `a` to allow once, `A` (shift) for session, `d` to deny.
- **Cursor Agent**: `y` approve, `n` reject. Use `--yolo --trust` at launch to skip prompts.

Approve routine prompts by default. Pause and ask before destructive operations such as deleting files, force pushing, dropping databases, or running unfamiliar scripts.

### Tracking completion

Poll pane output and classify state:

1. **Still working** — output streaming, spinner visible
2. **Blocked on a permission prompt** — approve it
3. **Finished** — prompt/input area reappears, "Done" or completion message visible
4. **Errored** — error messages, stack traces

If the user asked you to watch something, continue monitoring and send a concise completion summary suitable for a phone notification.

### Multi-agent coordination

When multiple agent sessions are running:

- Track which session is doing what by inspecting pane content.
- Avoid sending conflicting tasks to agents working in the same directory
- If one agent's output is needed as input for another, wait for the first to finish
- Summarize cross-session status when the user asks "what's going on" or "how's it going"

## Examples

User: "What's happening in the backend pane?"
Action: list sessions, capture likely panes, identify the backend process, then summarize current status and any errors.

User: "Tell the Codex pane to fix the failing test."
Action: capture the pane to verify it is Codex, send the prompt with literal send-keys plus Enter, monitor for approvals, then report the result.

## Escalation

Ask before acting when:

- An agent wants to do something destructive (`rm -rf`, `git push --force`, drop table)
- An agent is asking a question that requires the user's judgment
- An agent has failed repeatedly on the same task
- You're unsure which agent or session to target
- The task is ambiguous and could be interpreted multiple ways

Don't escalate for routine approvals — just approve and move on.

# Insights

---

- On this machine, many tmux sessions are numeric auto-created sessions, so session names are not a stable semantic identifier. The orchestrator should rely on a local pane registry with aliases and roles.
- tmux control mode is event-driven but session-scoped. For a multi-session observer, the daemon should run one control-mode client per hot session or combine control mode with `capture-pane` resyncs.
- V1 does not need Pipecat or `pi-coding-agent` if the user interaction is explicit push-to-talk. The harder problem is safe tmux orchestration, not full duplex speech.
- Even if the main long-term use case is mobile, web-first is the lower-risk first client as long as the backend contract is designed for later native mobile reuse.
- Local testing confirmed that Claude Code CLI can stream structured non-interactive output with `claude -p --verbose --output-format stream-json --include-partial-messages ...`.
- The main harness seam should be normalized events, not raw provider/CLI output. That keeps Claude Code CLI and `pi-coding-agent` swappable.
- As of 2026-04-11, Overwatch uses Deepgram for both prerecorded STT and streaming TTS. Deepgram TTS works with incremental `Speak` messages, but the last buffered fragment does not reliably complete unless the adapter sends a final `Flush`, so token-by-token streaming should still batch into sentence-ish chunks and flush once per response boundary.
- Codex (OpenAI) in tmux requires `send-keys -l` for the text body and a separate `send-keys Enter` to submit. A single `send-keys "text\nEnter"` does not work — Enter just drops to a new line inside the Codex prompt. The correct pattern is: `tmux send-keys -t <pane> -l "your prompt here"` followed by `tmux send-keys -t <pane> Enter`. This is different from Claude Code CLI, which accepts input normally. Any tmux actuator code must account for per-agent submission quirks.
- Prompt instructions are not a substitute for tmux targeting state. The orchestrator needs a pane registry with project root, inferred agent kind, cwd, recent output, and aliases so it can identify panes semantically instead of asking the user for session numbers.
- For session summaries, live tmux inspection must be the first source of truth. Persistent memory is useful only as supporting context and should never replace checking the current tmux server.
- The normal memory pattern from Halo is a better fit than a supervision tracker for now. Small markdown memories under `~/.overwatch/memory` are less likely to mislead the orchestrator into treating stale records as current session state.
- Scheduled or delegated background work should not share the same delivery path as a foreground voice turn. Overwatch needs a separate notification channel and inbox so background results can reach mobile clients even when no turn is active.
- If Overwatch becomes a true mobile control plane for agents, a single bidirectional WebSocket is the right transport. But the socket should be a typed event delivery layer over durable stores, not the source of truth itself.
- A serialized turn coordinator is the right bridge between old request/response routes and the new control plane. It lets foreground turns and scheduled background jobs share one agent session without racing each other, while still producing durable notifications for background results.
- For the current push-to-talk mobile flow, a separate STT upload endpoint plus WebSocket text turns is cleaner than pushing raw audio through the control-plane socket. It keeps media ingestion simple while moving orchestration onto the realtime channel.
- For TestFlight stability, disable optional startup-time native UI features before chasing deeper runtime issues. In this app, forcing `GlassSurface` to a plain `View` and setting `newArchEnabled: false` is the right first stabilization step for release-only Hermes/iOS launch crashes.
- CLI reconnect logs are part of the pairing UX. When the local backend reconnects, the terminal should reprint the current QR code and room code so the phone can re-scan without waiting for the operator to restart `overwatch start`.

# Initial Research: Halo-2 Reuse, tmux Surface, and MVP Direction

**Date:** 2026-04-05
**Status:** Historical (the MVP it scoped has shipped and been substantially rewritten in the 2026-05-02 overhaul)
**Related Docs:** [../plans/implemented/mvp-plan-2026-04-05.md](../plans/implemented/mvp-plan-2026-04-05.md), [../architecture/007-post-overhaul-architecture.md](../architecture/007-post-overhaul-architecture.md)

## Goal

Define the fastest credible path to a desktop voice orchestrator that can:

- hold a spoken conversation with an "orchestrator" Claude Code or Codex session
- inspect existing tmux sessions and panes
- capture outputs from one pane and inject or paste them into another pane
- keep the door open for deeper Halo-2 voice-pipeline reuse later

## Existing Reuse Candidate: Halo-2

The strongest reusable parts of `halo-2` are not the Pi-specific runtime pieces or the exact `pi-coding-agent` dependency. They are the system-shape patterns in `cloud/pi-agent/`:

- A thin HTTP/SSE bridge around an embedded agent session
- Explicit session actions returned as structured JSON and surfaced by the bridge
- Deliberate capability layering: always-on primitives in code, workflow guidance in docs and skills

Relevant files:

- `halo-2/cloud/pi-agent/src/index.ts`
- `halo-2/cloud/pi-agent/src/bridge/handler.ts`
- `halo-2/cloud/pi-agent/src/extensions/session.ts`
- `halo-2/docs/plans/017-harness-capability-layering.md`

Recommended reuse:

- reuse the bridge shape and event model
- reuse the "small always-on primitive set" principle
- reuse the idea of structured session actions for voice-driven control changes

Do not reuse directly for MVP:

- `pi-coding-agent` as a required runtime dependency
- Pi-specific SSH extensions
- Raspberry Pi wake-word and device ownership assumptions
- the Pi-hosted Pipecat deployment layout

## What tmux Gives Us Already

This machine is on `tmux 3.6a`. The core commands needed for the orchestrator MVP already exist locally:

- `list-sessions` and `list-panes` for discovery
- `display-message -p` for formatted metadata reads
- `capture-pane -p` for pane snapshot and scrollback reads
- `send-keys` for keystroke injection
- `load-buffer` and `paste-buffer` for cross-pane paste operations
- `pipe-pane` and `tmux -C` control mode for streaming or event-driven observation

Important details from local `man tmux` plus tmux control-mode docs:

- `capture-pane -p` can print pane content to stdout, with `-S` and `-E` controlling scrollback ranges.
- `capture-pane -a` targets the alternate screen, which matters for full-screen programs.
- `send-keys -l` sends literal UTF-8 text, which is safer for pasting free text than key-name parsing.
- `load-buffer -` reads buffer content from stdin.
- `paste-buffer -p -r` preserves bracketed paste behavior and avoids newline rewriting.
- control mode emits `%output`, `%window-add`, `%window-close`, `%pane-mode-changed`, and related notifications.

One major constraint:

- a tmux control-mode client only streams pane output for the session it is attached to, not the entire server

That means a serious observer has two options:

1. run one control-mode client per target session
2. use hybrid observation: control mode for hot panes plus `capture-pane` for discovery and resync

## Harness Options Compared

### Option A: Claude Code CLI wrapper

Status after local test: viable and preferred for v1.

What was verified locally:

- `claude -p` works non-interactively
- `--output-format stream-json` produces incremental structured events
- `--include-partial-messages` emits assistant deltas before completion
- the stream includes `message_start`, `content_block_delta`, `assistant`, and final `result`
- the installed CLI is using the user's existing Claude Code auth path rather than requiring an API key for this test
- the session init output exposes loaded skills, plugins, slash commands, and tool inventory

One CLI constraint found during testing:

- `--output-format stream-json` in print mode requires `--verbose`

Why this is a good fit:

- preserves the existing Claude Code product surface and likely the user's current subscription/auth path
- supports project-local plugins and skills
- gives a structured event stream that is close enough to the Halo-2 SSE bridge shape
- avoids adopting a second agent harness too early

Main downside:

- the backend becomes a wrapper around a subprocess, so some behavior is CLI-shaped rather than library-shaped

### Option B: pi-coding-agent

Status: keep as fallback, not first choice.

Why it is still attractive:

- embedded library model
- direct event subscription
- familiar Halo-2-style extension surface
- clean place to add custom orchestration tools

Why it is not the first choice now:

- it introduces a second harness when Claude Code CLI already works
- it does not help with the user's current Claude Code subscription/auth preference
- it creates migration work if the end state is still "use Claude Code"

## Harness Recommendation

Use a swappable harness boundary with:

- `Claude Code CLI wrapper` as the default implementation
- `pi-coding-agent` as the backup implementation

The tmux orchestration logic should live outside the harness. The harness should only be responsible for:

- accepting a user turn
- loading prompt context and skills/plugins
- streaming assistant output and tool events
- returning a final completed turn result

## What the Current tmux Layout Suggests

The current tmux server already contains both named project sessions and many numeric auto-created sessions. Session names alone are not a reliable semantic identifier.

Implication:

- the project needs an explicit pane registry with tags, aliases, and optional role labels such as `orchestrator`, `worker`, `project`, `interactive`, or `ignore`

The panes also expose enough metadata to classify likely agent panes:

- `pane_current_command`
- `pane_title`
- `pane_pid`
- session and window names

This is enough for an MVP classifier, but not enough for trust. The registry still needs an operator-owned mapping file.

## Voice Pipeline Recommendation

For the first MVP, the voice stack should stay secondary to the tmux control plane and should not depend on Pipecat.

Recommended approach:

- build the tmux observation and actuation daemon first
- define a speech adapter interface on top of it
- start with a simple push-to-talk loop with explicit `start speaking` and `stop speaking`
- keep Pipecat as a phase-2 backend if full duplex, richer interruption handling, or Halo-2 parity becomes important

Why not lead with Pipecat for MVP:

- the hard part of this project is cross-session control, not audio transport
- Pipecat is useful, but it adds transport, lifecycle, and provider integration complexity before the tmux core exists
- Halo-2's best immediate reuse is the bridge and session model, not the whole speech runtime
- a start/stop speaking UX does not need a full duplex voice framework yet

## TTS Direction

Use a swappable TTS adapter layer from the beginning.

Recommended order:

1. Cartesia as the default adapter
2. ElevenLabs or Gemini TTS as later alternatives if needed

Why Cartesia first:

- already used in Halo-2
- already aligned with the "stream assistant text as it arrives" model
- minimizes provider churn while the orchestration layer is still changing

The important architectural rule is:

- the backend should not expose provider-specific behavior to the client
- the backend should accept assistant text chunks and feed them into a streaming TTS adapter
- the client should only receive playable audio chunks or audio URLs plus text updates

Why keep Pipecat on the roadmap:

- it already matches the Halo-2 direction
- it gives a path to stronger VAD, streaming, and interruption behavior later
- it can sit behind the same orchestrator bridge once the tmux control plane is stable

## Recommended MVP Shape

Build a local daemon with two main surfaces:

1. `tmux observer`
   - discovers sessions and panes
   - maintains a tagged registry
   - captures recent output and can subscribe to live changes

2. `tmux actuator`
   - sends text, keys, and pasted buffers into panes
   - copies content from source pane snapshots into target panes
   - exposes explicit commands instead of raw shell-by-default behavior

3. `conversation bridge`
   - accepts transcribed speech text from a client
   - forwards it to the orchestrator harness
   - streams back orchestrator output for TTS playback

4. `voice client`
   - records microphone audio on explicit start
   - stops recording on explicit stop
   - sends audio or transcription to the backend
   - plays the synthesized reply audio or spoken text response

The orchestrator harness itself should be swappable:

- default: Claude Code CLI wrapper
- fallback: pi-coding-agent

The backend should not couple tmux/session logic to either implementation.

## Client Platform Recommendation

For v1, build a web client first, but make it mobile-shaped from day one.

Recommended client order:

1. responsive web app
2. installable PWA if needed
3. native mobile app only after the backend contract and audio UX stabilize

Why web first:

- faster to iterate on the actual hard problem, which is tmux orchestration
- easier to test locally on desktop while still being reachable from a phone
- keeps the backend contract clean for later native clients
- avoids premature duplication across web and mobile

Why not jump straight to native mobile:

- the speech UX is still undefined enough that native-specific work is likely to be churn
- the backend contract, auth, and remote connectivity story should settle first
- the first useful version only needs start/stop speaking, transcript display, and audio playback

Important operational note:

- because the main use case includes using this while away from the Mac, remote connectivity and auth matter early
- the backend should be designed to sit behind a secure tunnel such as Tailscale rather than assuming same-LAN access only

## Risks

- Numeric or reused session names make targeting ambiguous without a registry.
- Some panes may be in alternate-screen applications, so snapshotting must handle `capture-pane -a` when needed.
- `send-keys` is easy to misuse; copy/paste paths should prefer tmux buffers or bracketed paste over raw keystroke injection.
- Control mode is session-scoped, so naive "watch the whole server" designs will miss output from unattached sessions.

## Recommendation

Use Halo-2 as a pattern library, not as a direct code transplant.

For MVP:

- use a Claude Code CLI wrapper as the orchestrator harness
- build a local tmux control daemon around control mode plus snapshot capture
- expose a small command surface for discovery, capture, inject, and copy/paste
- add a simple web client with explicit start/stop speaking controls
- stream assistant text chunks into a Cartesia-backed TTS adapter
- keep the backend contract ready for later harness and TTS swaps

## Sources

- Pipecat quickstart: https://docs.pipecat.ai/pipecat/get-started/quickstart
- tmux control mode wiki: https://github.com/tmux/tmux/wiki/Control-Mode
- tmux man page reference: https://man7.org/linux/man-pages/man1/tmux.1.html

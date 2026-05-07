# Overwatch

Voice-controlled orchestrator for tmux-hosted coding agent sessions. Control Claude Code, Pi, Hermes, and other agents running on your Mac from your phone.

> **Status (May 2026):** private alpha. Pipecat Cloud handles the voice loop;
> the Mac runs only the session-host daemon; the relay mints Pipecat Cloud
> sessions and routes orchestrator ↔ daemon traffic. The canonical "what is"
> doc is [`docs/architecture/007-post-overhaul-architecture.md`](./docs/architecture/007-post-overhaul-architecture.md).

## Install First

The installer now handles the machine provisioning step for macOS:
- installs Homebrew if needed
- installs or upgrades `node`, `git`, and `tmux`
- clones or updates Overwatch into `~/.overwatch/app`
- installs the app dependencies locally
- exposes `overwatch` on your PATH and installs `pi` the upstream-supported way via `npm install -g @mariozechner/pi-coding-agent`

```bash
eval "$(curl -fsSL https://raw.githubusercontent.com/skap3214/overwatch/main/install.sh)"
```

Then configure only the user-specific pieces:

```bash
overwatch setup
overwatch start
```

## What `overwatch setup` does

`overwatch setup` owns the user-specific setup after the machine-level installer runs. It helps you:
- choose the active agent harness
- install the bundled Overwatch skill from `.agents/skills/overwatch` with `npx skills@latest add`
- sign into a Pi provider or import an existing Pi auth file when using `pi-coding-agent`
- save Deepgram STT/TTS credentials and model choices
- configure one or more supported terminals to auto-open tmux on new tabs
- turn the background gateway on or off

The two user actions that can still require a human are:
- choosing/configuring the terminal they actually use
- completing the Pi OAuth/browser flow if no reusable auth already exists

## Agent Setup

If another coding agent is setting this up from the repo URL, point it at the repo-root onboarding doc:

```text
Follow AGENT_SETUP.md from https://github.com/skap3214/overwatch
```

That doc covers:
- the install-first flow
- the non-interactive `overwatch setup` flags
- the least-interruptive Pi auth paths
- exactly what human action is still required when auth cannot be imported

## Quick Start

```bash
overwatch setup
overwatch start
```

Scan the QR code with the Overwatch iOS app (TestFlight).

## Manual Setup

```bash
git clone https://github.com/skap3214/overwatch
cd overwatch
npm ci
```

### Configure

```bash
npm run setup
```

Useful non-interactive variants:

```bash
overwatch setup --non-interactive --deepgram-key <KEY> --agent-auth-file /path/to/auth.json --terminal ghostty
overwatch setup --non-interactive --deepgram-key <KEY> --agent-auth-file /path/to/auth.json --terminal existing-tmux
overwatch setup --terminal ghostty --terminal kitty
overwatch setup --agent hermes
overwatch setup --agent-provider anthropic
overwatch setup --stt deepgram --tts cartesia --stt-model nova-3
overwatch setup --stt xai --tts xai --xai-key <KEY>
overwatch setup --skills off
npx skills@latest add skap3214/overwatch/.agents/skills/overwatch --global --all --copy
```

### Start

```bash
npm run overwatch:start
```

This starts the background launchd gateway, then prints the QR code and room details needed to pair the iOS app. `overwatch start` is an alias of `overwatch gateway start`.

### Other Commands

```bash
npm run overwatch:status     # connection + config status
npm run overwatch:update     # fetch latest CLI/app and refresh the wrapper
```

### CLI Schema

```bash
overwatch setup [--agent <id>] [--skills on|off] [--terminal <name>]
overwatch start
overwatch update
overwatch status
overwatch gateway start|stop|restart|status|info|logs
overwatch agent list|status|set <id>
```

## Architecture

```
iPhone ─ WebRTC ─ Pipecat Cloud (Python orchestrator)
                       │
                       │  HarnessCommand / HarnessEvent
                       │  over the relay's UserChannel
                       ▼
                 Cloudflare Worker relay
                       │
                       │  WebSocket
                       ▼
                Mac session-host daemon (TS)
                  └─ tmux + harness adapters
                     (Claude Code CLI / Pi / Hermes)
```

- **Phone (RN/Expo)**: Pipecat RN client — joins a Pipecat Cloud Daily room
  for voice + typed input; renders transcripts and harness UI.
- **Pipecat Cloud (Python)**: STT (Deepgram or xAI/Grok), TTS (Cartesia or xAI),
  VAD/smart-turn, inference gate, harness bridge, and the registry-driven event
  router. No voice LLM in the main flow — the harness *is* the LLM.
- **Relay (Cloudflare Worker)**: mints Pipecat Cloud sessions, derives the
  per-session HMAC token, and routes JSON envelopes between the orchestrator
  and the Mac daemon via a `UserChannel` durable object.
- **Mac daemon (TS)**: speaks the adapter-protocol back to the orchestrator,
  runs the local tmux + harness fleet, hosts the local REST API the mobile app
  uses for monitors / tmux / health.

## API Keys Required

| Service | Purpose | Get one at |
|---|---|---|
| Pipecat Cloud | Hosts the cloud orchestrator | https://daily.co/products/pipecat-cloud |
| Deepgram | Server-side STT (Nova-3) — default provider | https://console.deepgram.com |
| xAI | Server-side STT + TTS (Grok) — alternative provider | https://console.x.ai |
| Cartesia | Server-side streaming TTS (Sonic) — default provider | https://play.cartesia.ai |
| Pi provider (Anthropic, OpenAI Codex, GitHub Copilot, etc.) | Agent access via Pi auth | Configured during `overwatch setup` |

## Speech Stack

- STT: Deepgram Nova-3 (default) or xAI/Grok, streaming with interim results.
- TTS: Cartesia Sonic (default) or xAI, streaming PCM as the assistant text arrives.
- VAD: Silero; turn-detection: pipecat smart-turn.
- The voice loop runs entirely server-side — the phone is a thin WebRTC client.
- Switch providers: `overwatch setup --stt xai --tts xai` (or `--stt grok`).

## Project Structure

```
protocol/               JSON Schema — single source of truth for the wire protocol
pipecat/                Python orchestrator (Pipecat Cloud deploy target)
packages/
  session-host-daemon/  TS daemon on the user's Mac (tmux + harness fleet)
  cli/                  TS CLI (overwatch setup/start/status/update)
  shared/               Generated TS types + small utility helpers
overwatch-mobile/       iOS app (React Native/Expo, Pipecat RN client)
relay/                  Cloudflare Worker relay
docs/                   Architecture docs + plans + research
```

## License

MIT

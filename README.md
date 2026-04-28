# Overwatch

Voice-controlled orchestrator for tmux-hosted coding agent sessions. Control Claude Code, Codex, and other agents running on your Mac from your phone.

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
overwatch setup --non-interactive --deepgram-key <KEY>
overwatch setup --non-interactive --deepgram-key <KEY> --terminal ghostty
overwatch setup --terminal ghostty --terminal kitty
overwatch setup --agent hermes --gateway on
overwatch setup --agent-provider anthropic
overwatch setup --agent-auth-file /path/to/auth.json --non-interactive
overwatch setup --stt deepgram --tts deepgram --stt-model nova-3 --tts-model aura-2-aries-en
overwatch setup --skills off
npx skills@latest add skap3214/overwatch/.agents/skills/overwatch --global --all --copy
```

### Start

```bash
npm run overwatch:start
```

This starts the backend, connects to the relay, and shows a QR code. Scan it with the iOS app.

### Other Commands

```bash
npm run overwatch:status     # connection + config status
npm run overwatch:sessions   # list tmux sessions
```

### CLI Schema

```bash
overwatch setup [--agent <id>] [--skills on|off] [--terminal <name>] [--gateway on|off]
overwatch start
overwatch status
overwatch gateway start|stop|restart|status|logs
overwatch agent list|status|set <id>
overwatch sessions
```

## Architecture

```
iPhone → Relay (Cloudflare Worker) → Mac
           E2E encrypted              Backend + Agent + tmux
```

- **Phone**: voice input, text input, transcript display, TTS playback
- **Relay**: stateless WebSocket forwarder, E2E encrypted with nacl.box
- **Mac**: pi-coding-agent, Deepgram STT/TTS, tmux control

## API Keys Required

| Service | Purpose | Get one at |
|---|---|---|
| Pi provider (Anthropic, OpenAI Codex, GitHub Copilot, etc.) | Agent access via Pi auth | Configured during `overwatch setup` |
| Deepgram | Speech-to-text + text-to-speech | https://console.deepgram.com |

## Speech Stack

- Overwatch uses Deepgram for prerecorded STT and streaming TTS.
- TTS streams PCM audio chunks as the assistant text arrives, rather than waiting for the full reply.
- The default Deepgram TTS voice is `aura-2-aries-en`.

## Project Structure

```
src/                    Backend (Node/Hono)
overwatch-mobile/       iOS app (React Native/Expo)
packages/cli/           CLI tool
packages/shared/        Shared crypto
relay/                  Cloudflare Worker relay
docs/                   Architecture docs + plans
```

## License

MIT

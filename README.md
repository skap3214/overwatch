# Overwatch

Voice-controlled orchestrator for tmux-hosted coding agent sessions. Control Claude Code, Codex, and other agents running on your Mac from your phone.

## Quick Setup

```bash
eval "$(curl -fsSL https://raw.githubusercontent.com/skap3214/overwatch/main/install.sh)"
```

Then:

```bash
overwatch setup    # configure API keys + terminal
overwatch start    # start backend + show QR code
```

Scan the QR code with the Overwatch iOS app (TestFlight).

## Manual Setup

```bash
git clone https://github.com/skap3214/overwatch
cd overwatch
npm install
```

### Configure

```bash
npm run setup
```

This will:
- Check for pi-coding-agent OAuth (`~/.pi/agent/auth.json`)
- Prompt for Deepgram and Cartesia API keys
- Configure your terminal (Ghostty, Kitty, iTerm2, or Alacritty) to auto-start tmux

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

## Architecture

```
iPhone → Relay (Cloudflare Worker) → Mac
           E2E encrypted              Backend + Agent + tmux
```

- **Phone**: voice input, text input, transcript display, TTS playback
- **Relay**: stateless WebSocket forwarder, E2E encrypted with nacl.box
- **Mac**: pi-coding-agent, Deepgram STT, Cartesia TTS, tmux control

## API Keys Required

| Service | Purpose | Get one at |
|---|---|---|
| Anthropic | Agent (via pi-coding-agent OAuth) | Auto-configured on first agent run |
| Deepgram | Speech-to-text | https://console.deepgram.com |
| Cartesia | Text-to-speech | https://play.cartesia.ai |

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

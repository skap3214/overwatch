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

## Agent Setup (Claude Code, Codex, etc.)

If you're using an AI coding agent to set this up, copy this prompt:

````
Install and configure Overwatch — a voice-controlled orchestrator for tmux coding sessions, controllable from an iPhone.

Step 1: Install Overwatch
Run: eval "$(curl -fsSL https://raw.githubusercontent.com/skap3214/overwatch/main/install.sh)"
If `overwatch` is not found after install, run: export PATH="$HOME/.overwatch/bin:$PATH"

Step 2: Configure the AI agent
Run `pi` to launch the pi-coding-agent interactive setup. This will open a browser for OAuth authentication. Once the user has authenticated, they should type /exit to return. Verify it worked by checking that ~/.pi/agent/auth.json exists and is non-empty.

Step 3: Get API keys
Ask the user for their Deepgram API key (for speech-to-text, get one at https://console.deepgram.com).
Ask the user for their Cartesia API key (for text-to-speech, get one at https://play.cartesia.ai).

Step 4: Configure terminal
Ask the user which terminal they use. Supported terminals: Ghostty, Kitty, Alacritty, iTerm2.
If they use cmux, no terminal configuration is needed (cmux has built-in multiplexing).
Then run: overwatch setup --non-interactive --deepgram-key <KEY> --cartesia-key <KEY> --configure-terminal <terminal>

Step 5: Verify setup
Run: overwatch status
Confirm that the config shows the API keys are set and the terminal is configured.
Tell the user: "Setup complete. Open a new terminal tab — it will auto-start a tmux session. All new tabs will do this from now on. Then run `overwatch start` to begin."

Step 6: Start Overwatch
Run: overwatch start
This starts the backend, connects to the relay, and shows a QR code.
The user should scan the QR code with the Overwatch iOS app (available on TestFlight).
````

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

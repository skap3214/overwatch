## Overwatch Agent Setup Instructions

Install and configure Overwatch — a voice-controlled orchestrator for tmux coding sessions, controllable from an iPhone.

Prerequisites: macOS, Homebrew, Node.js 20+, Git. If any are missing, install them first.

### Step 1: Install Overwatch

Run: `eval "$(curl -fsSL https://raw.githubusercontent.com/skap3214/overwatch/main/install.sh)"`

If `overwatch` is not found after install, run: `export PATH="$HOME/.overwatch/bin:$PATH"`

### Step 2: Run interactive setup

Run: `overwatch setup`

This will walk through:
- AI agent login (select a provider like Anthropic, OpenAI, GitHub Copilot, etc. — opens browser for OAuth)
- Deepgram API key (for speech-to-text — get one at https://console.deepgram.com)
- Cartesia API key (for text-to-speech — get one at https://play.cartesia.ai)
- Terminal configuration (select which terminals to auto-start tmux — installs tmux via brew if needed)

Ask the user for their API keys before running setup so you can enter them when prompted.
If the user doesn't have API keys yet, tell them to sign up at the URLs above.

### Step 3: Verify setup

After setup completes, check that:
- `~/.overwatch/config.json` exists and has `deepgramApiKey` and `cartesiaApiKey`
- `~/.pi/agent/auth.json` exists and is non-empty (has provider credentials)
- `~/.overwatch/tmux-session.sh` exists (tmux auto-start script)

Tell the user: "Setup complete. Restart your terminal — new tabs will auto-start tmux sessions. Then run `overwatch start` to begin."

### Step 4: Start Overwatch

Run: `overwatch start`

This starts the backend, connects to the relay, and shows a QR code.
The user should scan the QR code with the Overwatch iOS app (available on TestFlight).

### Non-interactive setup

If you already have the keys:

```bash
overwatch setup --non-interactive --deepgram-key <KEY> --cartesia-key <KEY> --configure-terminal <terminal>
```

Supported terminals: ghostty, kitty, alacritty, iterm2. cmux needs no configuration.

Note: `--non-interactive` skips the AI agent login. Run `overwatch setup` interactively for that, or run `pi` and use `/login`.

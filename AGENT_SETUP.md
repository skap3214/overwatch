## Overwatch Agent Setup Instructions

Install and configure Overwatch — a voice-controlled orchestrator for tmux coding sessions, controllable from an iPhone.

Prerequisites: macOS, Homebrew, Node.js 20+, Git. If any are missing, install them first.

### Step 1: Install Overwatch

Run: `eval "$(curl -fsSL https://raw.githubusercontent.com/skap3214/overwatch/main/install.sh)"`

If `overwatch` is not found after install, run: `export PATH="$HOME/.overwatch/bin:$PATH"`

### Step 2: Configure the AI agent

Check if `~/.pi/agent/auth.json` exists and is non-empty (not just `{}`). If it does, the agent is already configured — skip to Step 3.

If not, the user needs to authenticate with an AI provider. Run: `pi`

This launches the pi-coding-agent. The user should type `/login`, select their provider (Anthropic, OpenAI, GitHub Copilot, etc.), and complete the OAuth flow in their browser. Once authenticated, they should type `/exit` to return.

Verify it worked: `cat ~/.pi/agent/auth.json` should show provider credentials.

### Step 3: Get API keys

Ask the user for:
- **Deepgram API key** (for speech-to-text and text-to-speech) — sign up at https://console.deepgram.com

### Step 4: Configure terminal + API keys

Ask the user which terminal they use. Supported terminals: Ghostty, Kitty, Alacritty, iTerm2, cmux.

If they use **cmux**, no terminal configuration is needed — cmux has built-in multiplexing. Run:
```bash
overwatch setup --non-interactive --deepgram-key <KEY>
```

For all other terminals, run:
```bash
overwatch setup --non-interactive --deepgram-key <KEY> --configure-terminal <terminal>
```
Terminal names: `ghostty`, `kitty`, `alacritty`, `iterm2` (lowercase).

### Step 5: Verify and start

Check the setup:
- `cat ~/.overwatch/config.json` — should have `deepgramApiKey`
- `cat ~/.pi/agent/auth.json` — should have provider credentials (not empty `{}`)

If both look good, tell the user:
> Setup complete! Restart your terminal (new tabs will auto-start tmux sessions), then run `overwatch start`. It will show a QR code — scan it with the Overwatch iOS app (TestFlight).

If `~/.pi/agent/auth.json` is missing or empty, tell the user:
> Almost done! Run `pi`, type `/login`, pick your AI provider, and complete the login. Then run `overwatch start`.

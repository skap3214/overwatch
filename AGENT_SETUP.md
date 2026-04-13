## Overwatch Agent Setup Instructions

Install and configure Overwatch — a voice-controlled orchestrator for tmux coding sessions, controllable from an iPhone.

Assume the repo-root `install.sh` is the first step. It now provisions Homebrew, Node.js, Git, tmux, the repo checkout, the local app dependencies, and installs `pi` globally using the upstream-supported npm global install path. `overwatch setup` is configuration-only.

### Step 1: Install Overwatch

Run: `eval "$(curl -fsSL https://raw.githubusercontent.com/skap3214/overwatch/main/install.sh)"`

If `overwatch` is not found after install, run: `export PATH="$HOME/.overwatch/bin:$PATH"`

### Step 2: Configure the AI agent

Check if `~/.pi/agent/auth.json` exists and is non-empty (not just `{}`). If it does, the Pi agent is already configured — skip to Step 3.

Preferred paths, in order:

1. If the user already has a valid Pi auth file on another machine or from a prior install, import it:
   `overwatch setup --agent-auth-file /path/to/auth.json --non-interactive`
2. If the user can complete one browser login now, run:
   `overwatch setup --agent-provider anthropic`
   Replace `anthropic` with another provider id if the user wants a different Pi provider.
3. If the direct setup flow fails, fall back to the raw Pi UI:
   `pi`
   Then have the user run `/login`, pick their provider, and complete the flow.

Important: there is no true silent OAuth path for the built-in Pi providers. If auth cannot be imported, the human still has to approve a browser login and sometimes paste a code or callback URL. Your job as the agent is to make that handoff explicit and brief.

Verify success with:
- `cat ~/.pi/agent/auth.json`
- it should contain at least one provider entry with non-empty credentials

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
- terminal config should either already open tmux automatically, or the user intentionally chose to skip that step

If both look good, tell the user:
> Setup complete! Restart your terminal (new tabs will auto-start tmux sessions), then run `overwatch start`. It will show a QR code — scan it with the Overwatch iOS app (TestFlight).

If `~/.pi/agent/auth.json` is missing or empty, tell the user:
> Almost done! Pi auth still needs a human browser login. Run `overwatch setup --agent-provider anthropic` and complete the provider login, or run `pi` and use `/login`. Then run `overwatch start`.

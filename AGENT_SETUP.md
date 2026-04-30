## Overwatch Agent Setup Instructions

Install and configure Overwatch — a voice-controlled orchestrator for tmux coding sessions, controllable from an iPhone.

Assume the repo-root `install.sh` is the first step. It now provisions Homebrew, Node.js, Git, tmux, the repo checkout, the local app dependencies, and installs `pi` globally using the upstream-supported npm global install path. `overwatch setup` owns user configuration and installs the Overwatch skill with `npx skills@latest add`.

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

If they already use **tmux** and care about their own tmux config/keybindings, skip Overwatch's tmux setup. Overwatch will still discover and control tmux sessions they create themselves:
```bash
overwatch setup --non-interactive --deepgram-key <KEY> --terminal existing-tmux
```

If they use **cmux**, no terminal configuration is needed because cmux has built-in multiplexing. Run:
```bash
overwatch setup --non-interactive --deepgram-key <KEY>
```

For all other users, run managed terminal setup:
```bash
overwatch setup --non-interactive --deepgram-key <KEY> --agent-auth-file /path/to/auth.json --terminal <terminal>
```
Terminal names: `ghostty`, `kitty`, `alacritty`, `iterm2` (lowercase).
Repeat `--terminal` or pass comma-separated values to configure more than one:
```bash
overwatch setup --terminal ghostty --terminal kitty
overwatch setup --terminal ghostty,kitty
```

Use `--terminal none`, `--terminal skip`, or `--terminal existing-tmux` to skip all Overwatch tmux/terminal changes.

Overwatch-managed tmux is intentionally native-first for non-tmux users: it enables reliable tmux scrollback, mouse support, truecolor, OSC 52 clipboard, and a large history, but avoids no-prefix key remaps, drag-copy overrides, and a visible tmux status bar. Existing tmux users should prefer the skip path instead of trying to merge opinions.

The gateway always runs as a background launchd service. Start it with `overwatch start` or `overwatch gateway start` after setup.

By default, setup installs the `overwatch` skill from `.agents/skills/overwatch` globally for detected skill-capable agents using `npx skills@latest add`. Only skip that with `--skills off` when intentionally configuring a machine that should not receive agent skills.

### Step 5: Verify and start

Check the setup:
- `cat ~/.overwatch/config.json` — should have `deepgramApiKey`
- `cat ~/.pi/agent/auth.json` — should have provider credentials (not empty `{}`)
- the setup output should show the `overwatch` skill installed, or it should print the `npx skills@latest add ...` fallback command shape
- terminal config should either already open Overwatch-managed tmux automatically, or the user intentionally chose `--terminal existing-tmux` / `skip` and will create tmux sessions themselves

If both look good, tell the user:
> Setup complete! Restart your terminal (new tabs will auto-start tmux sessions), then run `overwatch start`. The background gateway will start and print where to find the pairing details for the Overwatch iOS app (TestFlight).

If `~/.pi/agent/auth.json` is missing or empty, tell the user:
> Almost done! Pi auth still needs a human browser login. Run `overwatch setup --agent-provider anthropic` and complete the provider login, or run `pi` and use `/login`. Then run `overwatch start`.

# Plan: Overwatch CLI + Relay Server

**Date:** 2026-04-09
**Status:** Proposed
**Related Docs:** [../architecture/002-product-vision.md](../architecture/002-product-vision.md), [react-native-app-plan-2026-04-08.md](react-native-app-plan-2026-04-08.md), [background-notifications-plan-2026-04-09.md](background-notifications-plan-2026-04-09.md)
**Inspiration:** [Happy CLI relay architecture](https://happy.engineering/docs/how-it-works/)
**Update 2026-04-30:** The implemented CLI surface is now leaner than this proposal: `overwatch sessions` was removed, `overwatch start` is an alias for `overwatch gateway start`, foreground gateway mode is hidden/internal only, setup no longer accepts `--gateway`, `overwatch gateway info` reprints pairing details, and `overwatch update` handles installed CLI updates.
**Amends:** [react-native-app-plan-2026-04-08.md](react-native-app-plan-2026-04-08.md) — the mobile client is now WebSocket-first. The backend has already been refactored: `/api/v1/voice-turn` and `/api/v1/text-turn` are removed, turns go through the WebSocket, notifications also go through the WebSocket, and the remaining HTTP endpoints are `/api/v1/stt` and `/health`.
**Overrides insight:** [../insights.md](../insights.md) line about keeping STT upload separate from the control socket. In relay mode, there is no HTTP path to the Mac, so STT audio must flow through the WebSocket as `voice.audio` envelopes. In direct mode, the app may still use the HTTP STT endpoint.

## Outcome

A developer can install the Overwatch CLI, run one command, scan a QR code, and start controlling their tmux sessions from their phone. No Tailscale, no port forwarding, no ngrok.

## Why

The current setup requires Tailscale on both devices, manually entering a Tailscale IP, and running `npm run dev` from the repo. That's fine for us but too much friction for anyone else. The CLI + relay eliminates all of that.

## Architecture

```
┌──────────────┐                ┌──────────────────────┐                ┌──────────────┐
│   iPhone     │                │  Relay Server        │                │   Mac        │
│              │   WebSocket    │  (Cloudflare Worker)  │   WebSocket    │              │
│  Overwatch   ├───────────────►│                      │◄───────────────┤  Overwatch   │
│  Mobile App  │◄───────────────┤  Stateless broker    ├───────────────►│  CLI         │
│              │                │  E2E encrypted       │                │              │
└──────────────┘                └──────────────────────┘                │  Backend     │
                                                                       │  Agent       │
                                                                       │  tmux        │
                                                                       └──────────────┘
```

### How it works

1. Mac runs `npx overwatch start`
2. CLI starts the backend locally (harness, TTS, STT, scheduler)
3. CLI connects outward to `relay.overwatch.dev` via WebSocket
4. Relay assigns a **room code** (e.g. `ABCD-1234`)
5. CLI generates an X25519 key pair
6. CLI displays a QR code encoding `{ relay, room, hostPublicKey }`
7. Phone scans QR → generates its own key pair → connects to relay room
8. Phone sends its public key (plaintext, only the key — no sensitive data)
9. Both sides derive a shared secret → all subsequent messages are E2E encrypted
10. Relay sees only opaque binary frames from this point on

### Wire format

Every message through the relay after key exchange is a single binary WebSocket frame:

```
[24 bytes: nonce] [N bytes: nacl.box ciphertext (includes 16-byte Poly1305 auth tag)]
```

The plaintext inside the encrypted frame is a UTF-8 JSON `RealtimeEnvelope`:

```json
{ "id": "...", "type": "turn.text_delta", "createdAt": "...", "payload": { "turnId": "...", "text": "Hello" } }
```

One exception: `voice.audio` frames. The plaintext is a JSON envelope where `payload.data` contains the raw audio bytes as base64. This is encrypted the same way — the relay still sees only an opaque blob.

The relay forwards binary frames without parsing. It does not know whether a frame contains text, audio, or notifications.

### What flows through the relay

All messages use the same `RealtimeEnvelope` format already implemented in `src/realtime/protocol.ts`:

| Direction | Message Types |
|---|---|
| Phone → CLI | `client.hello` (with public key, plaintext), `turn.start`, `notification.ack`, `voice.audio` |
| CLI → Phone | `host.hello` (with public key acceptance, plaintext), `connection.ready`, `turn.started`, `turn.text_delta`, `turn.tool_call`, `turn.audio_chunk`, `turn.done`, `turn.tts_error`, `notification.snapshot`, `notification.created`, `notification.updated`, `voice.transcript` |

Only the initial key exchange messages (`client.hello`, `host.hello`) are plaintext. Everything after is encrypted.

### Voice in relay mode

The current app flow for push-to-talk is: record → POST `/api/v1/stt` (HTTP) → get transcript → send `turn.start` (WebSocket). In relay mode, the phone has no HTTP path to the Mac.

**Solution:** The phone sends audio over the WebSocket as a `voice.audio` envelope. The CLI (not the relay) handles it:

1. Phone records audio → base64 encodes → wraps in `{ type: "voice.audio", payload: { data, mimeType } }`
2. Phone encrypts and sends through relay
3. CLI receives → decrypts → extracts audio → POSTs to local `localhost:8787/api/v1/stt`
4. CLI gets transcript → wraps in `{ type: "voice.transcript", payload: { text } }` → encrypts → sends back through relay
5. Phone receives → decrypts → displays transcript → sends `turn.start` with the text (encrypted, through relay)

This means the CLI is **not** a transparent proxy — it is a protocol-aware bridge that terminates the E2E encryption and handles voice-to-STT translation. See "CLI bridge role" below.

### CLI bridge role

The CLI bridge sits between the relay and the local backend. It is **not** a dumb forwarder. It has three responsibilities:

1. **E2E termination**: decrypt incoming relay frames, re-encrypt outgoing frames. The local backend WebSocket speaks plaintext JSON (same as today).
2. **Voice proxy**: intercept `voice.audio` envelopes, call the local STT endpoint, return `voice.transcript`.
3. **Message forwarding**: all other envelopes are decrypted and forwarded to the local backend WebSocket as-is, and vice versa.

```
Phone ──encrypted──► Relay ──encrypted──► CLI bridge ──plaintext JSON──► Backend WS (localhost)
Phone ◄──encrypted── Relay ◄──encrypted── CLI bridge ◄──plaintext JSON── Backend WS (localhost)
```

The backend doesn't need any changes. It still sees a normal WebSocket client speaking plaintext `RealtimeEnvelope` JSON.

### Client transport abstraction

The mobile app must know whether it's in direct or relay mode because the transport behavior differs:

| Operation | Direct mode | Relay mode |
|---|---|---|
| WebSocket URL | `ws://<ip>:8787/api/v1/ws` | `wss://relay.overwatch.dev/api/room/<code>/ws/client` |
| Health check | `GET /health` (HTTP) | WebSocket connected = healthy |
| STT | `POST /api/v1/stt` (HTTP) | `voice.audio` envelope (WebSocket) |
| Encryption | None (trusted LAN) | nacl.box E2E |
| Turn start | `turn.start` envelope (plaintext) | `turn.start` envelope (encrypted) |
| Notifications | Same envelope format | Same envelope format (encrypted) |

`RealtimeClient` exposes a `mode: "direct" | "relay"` property set during connection. The `useOverwatchTurn` hook checks the mode to decide how to send voice recordings. The rest of the app logic (turn state, notifications, transcript) is mode-agnostic — it processes decrypted `RealtimeEnvelope` objects regardless of how they arrived.

## Relay Server (Cloudflare Worker)

### Why Cloudflare Workers

- Free tier: 100k requests/day, 10ms CPU per request
- Native WebSocket support via Durable Objects
- Global edge network — low latency from anywhere
- No server to manage
- `wrangler deploy` to ship

### Design

One Durable Object per room. Each room holds up to 2 WebSocket connections (host + client). The relay forwards both text and binary WebSocket frames. Text frames are used during the initial key exchange (`client.hello`, `host.hello`). Binary frames are used for all encrypted messages after key exchange. The relay does not inspect either type — it copies frames as-is.

```
relay/
  src/
    index.ts          — Worker entry, routes /api/room/:code
    room.ts           — Durable Object: holds 2 WebSockets, forwards binary frames
  wrangler.toml
  package.json
```

### Room lifecycle

1. Host connects → Durable Object created, room code generated
2. Client connects with room code → joined to the same Durable Object
3. Binary frames forwarded bidirectionally (relay never inspects content)
4. Either side disconnects → room torn down after 30s timeout (allows reconnect)
5. Both sides disconnect → Durable Object evicted by Workers runtime

### Room code format

Short, human-readable, easy to type if QR scan fails:

```
ABCD-1234
```

8 characters: 4 uppercase letters + 4 digits = ~4.5 million combinations. Rooms are ephemeral (destroyed on disconnect), so collisions are effectively impossible.

### API

```
GET /api/room/create          → { room: "ABCD-1234" }
GET /api/room/:code/ws/host   → WebSocket upgrade (host side)
GET /api/room/:code/ws/client → WebSocket upgrade (client side)
GET /api/health               → { ok: true }
```

### Security — E2E encryption from day one

All messages through the relay (after key exchange) are end-to-end encrypted. The relay is zero-knowledge — it forwards opaque binary blobs and cannot read any content.

**Crypto primitive: `nacl.box` (tweetnacl)**

Using one consistent construction everywhere:
- **Key exchange**: X25519 ECDH (built into `nacl.box.keyPair` and `nacl.box.before`)
- **Encryption**: XSalsa20-Poly1305 authenticated encryption (built into `nacl.box.after`)
- **Nonce**: 24 bytes, random per message (`nacl.randomBytes(24)`)
- **Library**: `tweetnacl` — 7KB, zero dependencies, works in both Node.js and React Native
- **Shared code**: `packages/shared/crypto.ts` used by CLI and mobile app

This is the same construction Happy CLI uses. `nacl.box` handles X25519 + XSalsa20-Poly1305 as a single primitive — no manual HKDF or AES-GCM composition needed.

**Key exchange flow:**

1. CLI generates key pair: `nacl.box.keyPair()` → `{ publicKey, secretKey }`
2. QR code encodes `{ relay, room, hostPublicKey: base64(publicKey) }`
3. Phone scans QR → generates its own key pair
4. Phone sends `{ type: "client.hello", payload: { clientPublicKey: base64(publicKey) } }` as plaintext JSON
5. CLI receives → derives shared key: `nacl.box.before(clientPublicKey, hostSecretKey)`
6. Phone derives same shared key: `nacl.box.before(hostPublicKey, clientSecretKey)`
7. Both sides now encrypt with `nacl.box.after(message, nonce, sharedKey)` and decrypt with `nacl.box.open.after(box, nonce, sharedKey)`

**Wire format (what the relay sees per WebSocket frame):**

```
[24 bytes: nonce] [N bytes: XSalsa20-Poly1305 ciphertext + auth tag]
```

**Key lifecycle:**
- Key pairs are ephemeral — generated fresh on each `overwatch start`
- Shared key lives in memory only, never persisted to disk
- Reconnecting to the same room reuses the key for that session
- New `overwatch start` = new key pair = new QR code

**What this protects against:**
- Relay operator reading messages ✓
- Man-in-the-middle on the relay ✓ (public keys exchanged via QR, not through relay)
- Room code brute-force ✓ (even if someone guesses the room code, they can't derive the shared key without the public key from the QR code)

**What this does NOT protect against:**
- Physical access to the Mac or phone (keys are in memory)
- Compromised CLI or app binary (supply chain attack)

## CLI (`overwatch`)

### Installation

```bash
npm install -g overwatch-cli
```

Or without global install:

```bash
npx overwatch-cli start
```

### Package structure

```
packages/
  cli/
    src/
      index.ts            — Entry point, command router
      commands/
        setup.ts          — First-time configuration (auth + terminal)
        start.ts          — Start backend + connect to relay + show QR
        sessions.ts       — List/watch tmux sessions
        status.ts         — Show connection status
      relay-bridge.ts     — Encrypted bridge: relay WS ↔ local backend WS
      backend.ts          — Spawns the backend as child process
      terminal-setup.ts   — Detect and configure terminal for tmux
      qr.ts               — QR code generation for terminal
      config.ts           — Read/write ~/.overwatch/config.json
    package.json
    tsconfig.json
  shared/
    crypto.ts             — nacl.box wrapper: keyGen, deriveShared, encrypt, decrypt
```

### Commands

#### `overwatch setup`

Interactive first-time setup. Handles auth and terminal configuration.

```
$ overwatch setup

Overwatch Setup
───────────────

Authentication
  The agent runtime uses pi-coding-agent with Anthropic OAuth.
  Checking ~/.pi/agent/auth.json... ✓ found

  If not found, the CLI runs the pi-coding-agent OAuth flow
  to create the auth file. No raw API key needed.

  Deepgram API key: ...          ✓
  Deepgram TTS model: ...        ✓

Terminal Setup
  Which terminal do you use?
    ❯ Ghostty
      Kitty
      iTerm2
      Alacritty
      Skip

  Found Ghostty config at ~/.config/ghostty/config
  → Added tmux auto-attach ✓

Config saved to ~/.overwatch/config.json
Run 'overwatch start' to begin.
```

**Auth model**: The agent harness uses pi-coding-agent which authenticates via OAuth to `~/.pi/agent/auth.json`. The CLI checks for this file and runs the OAuth flow if missing. The Deepgram API key and optional Deepgram TTS model are stored in `~/.overwatch/config.json` with `600` file permissions (owner read/write only). Future improvement: use macOS Keychain via `security` CLI.

This is consistent with the accepted product direction in `002-product-vision.md` — pi-coding-agent OAuth, no raw Anthropic API key management.

#### `overwatch start`

The main command. Does everything:

```
$ overwatch start

Starting Overwatch...
  Backend:  ✓ running on localhost:8787
  Relay:    ✓ connected to relay.overwatch.dev
  Room:     KFMX-7291

Scan this QR code with the Overwatch app:

  ██████████████████
  ██ ▄▄▄▄▄ █▄█ ████
  ██ █   █ █▀▄ ████
  ██ █▄▄▄█ █ █ ████
  ██████████████████

Or enter manually:
  Relay: relay.overwatch.dev
  Room:  KFMX-7291

Waiting for phone to connect...
  ✓ Phone connected! (E2E encrypted)

Overwatch is running. Press Ctrl+C to stop.
```

Under the hood:
1. Loads config from `~/.overwatch/config.json`
2. Starts the backend (imports and runs `src/index.ts` in-process, or spawns as child)
3. Generates X25519 key pair
4. Connects to `relay.overwatch.dev` as host, gets room code
5. Generates QR code encoding `{ relay, room, hostPublicKey }`
6. Waits for client `client.hello` with public key → derives shared key
7. Runs the encrypted bridge: relay WS ↔ local backend WS

#### `overwatch sessions`

Lists available tmux sessions:

```
$ overwatch sessions

  codex-main     3 panes   active
  claude-code    1 pane    idle
  server-logs    2 panes   active
```

#### `overwatch status`

Shows current connection state:

```
$ overwatch status

  Backend:     running (localhost:8787)
  Relay:       connected (relay.overwatch.dev)
  Room:        KFMX-7291
  Phone:       connected (last seen 3s ago)
  Encryption:  nacl.box (X25519 + XSalsa20-Poly1305)
  Agent:       idle
  Scheduled:   2 tasks
```

## Terminal Setup

The CLI configures the user's terminal to auto-start tmux on new tabs. This ensures every terminal tab is a tmux session that Overwatch can discover and control.

### Script

The CLI installs a script at `~/.overwatch/tmux-session.sh`:

```bash
#!/bin/bash
# overwatch: auto-start tmux session on new terminal tab
TMUX_BIN="${TMUX_BIN:-tmux}"
n=0
while $TMUX_BIN has-session -t "$n" 2>/dev/null; do
  n=$((n + 1))
done
exec $TMUX_BIN new-session -s "$n"
```

Each new tab gets its own numbered tmux session. Overwatch discovers these via `tmux list-sessions`.

### Terminal config changes

During `overwatch setup`, the CLI detects installed terminals and adds one line:

| Terminal | Config file | Line added |
|---|---|---|
| **Ghostty** | `~/.config/ghostty/config` | `command = ~/.overwatch/tmux-session.sh` |
| **Kitty** | `~/.config/kitty/kitty.conf` | `shell ~/.overwatch/tmux-session.sh` |
| **iTerm2** | Profile via `defaults write` | Sets default profile command |
| **Alacritty** | `~/.config/alacritty/alacritty.toml` | `[shell]\nprogram = "~/.overwatch/tmux-session.sh"` |

The CLI backs up the original config before modifying. `overwatch setup --undo` reverts the changes.

### Terminals not supported in v1

- **WezTerm** — Lua config, more complex to modify programmatically
- **Terminal.app** — plist-based, possible but low priority
- **tmux users** — if the user already runs tmux, skip this step

## Mobile App Changes

### QR Code Scanner

Add a QR code scan flow to the connection setup:

1. User taps "Scan QR" in settings
2. Camera opens
3. Scans QR → extracts `{ relay, room, hostPublicKey }`
4. Phone generates its own X25519 key pair via `tweetnacl`
5. Connects to `wss://relay.overwatch.dev/api/room/KFMX-7291/ws/client`
6. Sends `client.hello` with phone's public key (plaintext, contains only the key)
7. Both sides derive shared key via `nacl.box.before` → all subsequent messages encrypted
8. Relay bridges the opaque encrypted frames

### Connection modes

The app supports two connection modes:

| Mode | When | URL |
|---|---|---|
| Direct | User enters Tailscale/LAN IP manually | `ws://<ip>:8787/api/v1/ws` |
| Relay | User scans QR code | `wss://relay.overwatch.dev/api/room/<code>/ws/client` |

`RealtimeClient` exposes `mode: "direct" | "relay"`. In direct mode, messages are plaintext JSON to the backend. In relay mode, messages are encrypted with `nacl.box` before sending and decrypted after receiving. The rest of the app processes decrypted `RealtimeEnvelope` objects identically in both modes.

### New dependencies

- `expo-camera` — for QR code scanning
- `tweetnacl` — E2E encryption (7KB, zero deps, React Native compatible)

## Build Sequence

### Phase 1: Relay server + shared crypto

- Create `relay/` directory with Cloudflare Worker + Durable Object
- Implement room create, host connect, client connect, frame forwarding (text + binary)
- The relay forwards both text frames (key exchange) and binary frames (encrypted messages) without inspecting either
- Update `src/realtime/protocol.ts` to add new envelope types: `host.hello`, `voice.audio`, `voice.transcript`. The current protocol only models `client.hello`, `turn.*`, and `notification.*` — these three are new.
- Create `packages/shared/crypto.ts` — `nacl.box` wrapper: `generateKeyPair`, `deriveSharedKey`, `encrypt`, `decrypt`
- Deploy relay to `relay.overwatch.dev` (or temporary `overwatch-relay.<account>.workers.dev`)
- Test with a script: two clients connect, perform key exchange, send encrypted messages, verify relay can't read them
- **Gate:** two clients can connect, exchange keys, and send/receive encrypted messages through the relay

### Phase 2: CLI — setup + start + encrypted bridge

- Create `packages/cli/` with the command structure
- `overwatch setup`:
  - Check for `~/.pi/agent/auth.json` → run pi-coding-agent OAuth if missing
  - Prompt for one Deepgram key for STT + TTS, plus an optional Deepgram TTS model override → write `~/.overwatch/config.json` (mode 600)
  - Detect terminal → install `~/.overwatch/tmux-session.sh` → add config line
- `overwatch start`:
  - Start backend
  - Generate X25519 key pair
  - Connect to relay, get room code
  - Show QR code encoding `{ relay, room, hostPublicKey }`
  - Wait for `client.hello` → derive shared key
  - Run encrypted bridge: decrypt relay frames → forward as plaintext JSON to local backend WS; encrypt backend responses → forward to relay
  - Handle `voice.audio`: decrypt → POST to local `/api/v1/stt` → encrypt `voice.transcript` → send back
- **Gate:** run `overwatch start`, connect from a test client, send an encrypted text turn, get an encrypted response with TTS audio

### Phase 3: Mobile — QR scan + encrypted connection

- Install `tweetnacl` in the mobile app
- Add QR code scanner (`expo-camera`) to settings/connection flow
- On scan: generate key pair, send public key, derive shared key
- `RealtimeClient` gains `mode: "relay"`: encrypt outgoing with `nacl.box.after`, decrypt incoming with `nacl.box.open.after`
- Voice in relay mode: encrypt audio → send as `voice.audio` → receive `voice.transcript` → send `turn.start`
- Test full flow: CLI start → QR scan → voice turn → TTS playback, all E2E encrypted
- **Gate:** complete voice loop through the relay with E2E encryption

### Phase 4: CLI — tmux integration

- `overwatch sessions` — list tmux sessions
- `overwatch status` — show connection state, encryption info
- Auto-detect Ghostty + tmux and suggest session names
- **Gate:** `overwatch sessions` shows live tmux state

### Phase 5: Polish + distribution

- `npm publish` the CLI package
- Stable relay URL (`relay.overwatch.dev`)
- Error handling: relay disconnect, backend crash, room expiry, key renegotiation on reconnect
- `overwatch setup --undo` to revert terminal config changes
- CLI auto-update check
- README with setup guide

## What Changes vs Current Setup

| Current | With CLI + Relay |
|---|---|
| Clone repo, npm install, npm run dev | `npm install -g overwatch-cli && overwatch setup && overwatch start` |
| Install Tailscale on Mac + iPhone | Nothing extra needed |
| Manually enter Tailscale IP in app | Scan QR code |
| Backend dies if terminal closes | CLI manages process lifecycle |
| No auth | E2E encrypted relay (nacl.box) + room codes |
| Manual tmux setup | CLI configures terminal for auto-tmux |

## Costs

- **Cloudflare Workers free tier:** 100k requests/day. Each WebSocket message counts as a request. A typical voice turn is ~50-100 messages (text deltas + audio chunks). That's ~1000-2000 voice turns/day on free tier. More than enough for personal use. Paid tier ($5/mo) gives 10M requests.
- **Durable Objects:** $0.15/million requests after free tier. Negligible for personal use.

## Risks

1. **Cloudflare Workers WebSocket limits** — Workers have a 1MB message size limit. TTS audio chunks are base64-encoded PCM (~1-4KB each), well under the limit. Voice recordings for STT are larger (a 5-second recording at 16kHz mono 16-bit is ~160KB base64), but still well under 1MB. Encryption overhead is 40 bytes per frame (24-byte nonce + 16-byte auth tag).

2. **Durable Object cold starts** — First connection to a room may have ~50ms cold start. Negligible.

3. **Relay as single point of failure** — If Cloudflare Workers is down, the relay is down. Mitigation: the app falls back to direct connection (Tailscale/LAN IP) if the relay is unreachable.

4. **Room code guessing** — 4.5M combinations with ephemeral rooms makes brute-force impractical. Even if someone guesses a room code, they can't read messages without the shared key derived from the QR code's public key.

5. **Voice latency through relay** — voice recordings go through an extra hop (phone → relay → CLI → local STT → CLI → relay → phone) compared to direct mode (phone → backend STT). Added latency is ~2x network RTT to relay. For a Cloudflare edge node, this is ~20-50ms extra — acceptable.

## Not in Scope

- Multi-device support (multiple phones per Mac)
- Cloud-hosted backend (each user runs their own)
- Windows/Linux CLI (Mac-first, tmux is the target)
- App Store distribution (TestFlight for now)
- macOS Keychain for key storage (future improvement)

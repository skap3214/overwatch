# Gateway Service Architecture

**Status:** Implemented
**Date:** 2026-04-25
**Related:** [../plans/cli-and-relay-plan-2026-04-09.md](../plans/cli-and-relay-plan-2026-04-09.md)

## Decision

Overwatch treats the relay gateway as a durable local service. The public CLI no longer exposes a foreground gateway mode.

This follows the same operational pattern as Hermes-style gateways: a long-running supervised process owns platform connectivity, while gateway commands start, stop, restart, inspect, and tail that process. `overwatch start` is only a friendly alias for `overwatch gateway start`; both commands still print pairing details after the background service starts.

## Files

| Path | Purpose |
| --- | --- |
| `packages/cli/src/gateway-runtime.ts` | Starts/reuses the backend, starts the encrypted relay bridge, writes status, prints pairing |
| `packages/cli/src/gateway-state.ts` | PID file, status file, logs, durable host identity, durable room code |
| `packages/cli/src/commands/gateway.ts` | Public `overwatch gateway start/stop/restart/status/logs` command group plus the hidden supervisor entrypoint |
| `packages/cli/src/relay-bridge.ts` | Host-side encrypted relay bridge and heartbeat/reconnect behavior |
| `relay/src/room.ts` | Cloudflare Durable Object room, host/client WebSocket forwarding, persisted host public key/readiness |
| `overwatch-mobile/src/services/realtime.ts` | Phone-side relay WebSocket, E2E encryption, heartbeat/reconnect behavior |

## Local State

All service state is scoped under `~/.overwatch/`:

| Path | Purpose |
| --- | --- |
| `gateway.pid` | Current gateway PID, removed on clean shutdown |
| `gateway-status.json` | Last known relay/backend/phone status, room, host public key, timestamps |
| `host-key.json` | Durable X25519 host keypair used for persistent phone pairing |
| `pairing.json` | Durable relay room code |
| `logs/gateway.log` | Gateway/backend informational log |
| `logs/errors.log` | Gateway/backend warning/error log |

`host-key.json` and `pairing.json` are intentionally durable. A gateway restart should not force a phone re-scan. The room code alone is not a secret; E2E encryption still depends on the host key shown to the phone during pairing.

## Commands

| Command | Behavior |
| --- | --- |
| `overwatch start` | Alias for `overwatch gateway start` |
| `overwatch gateway start` | Start the launchd service, installing it first if missing, then print pairing QR/room info |
| `overwatch gateway stop` | Stop launchd service and signal any tracked gateway PID |
| `overwatch gateway restart` | Stop then start service, then print pairing QR/room info |
| `overwatch gateway status` | Print PID, service install state, relay/backend/phone status, room, logs |
| `overwatch gateway info` | Reprint the phone pairing QR code, room, relay, and host key from the latest gateway status |
| `overwatch gateway logs -n 80` | Print recent gateway log lines |

## Reconnect Semantics

The relay connection is designed to recover rather than stay literally uninterrupted. iOS can suspend the app, networks can hand off between Wi-Fi and cellular, and WebSockets can close without a clean close frame.

Current guarantees:

- The Mac gateway can stay alive independently of the terminal.
- `launchd` restarts the gateway after unexpected failure.
- The host uses a stable room code and stable host key across restarts.
- The relay persists host public key and last bridge readiness in Durable Object storage.
- Reconnecting clients receive cached `bridge.status` immediately when available.
- Host and phone heartbeat loops require three missed pongs before forcing a reconnect.
- Backend and relay reconnect loops continue indefinitely with capped exponential backoff.

## Operational Notes

- `overwatch status` includes gateway PID and pairing room summary.
- `overwatch gateway status` is the detailed diagnostic command.
- If pairing is broken or a phone should no longer be trusted, remove `~/.overwatch/host-key.json` and `~/.overwatch/pairing.json`, then restart the gateway and scan the new QR code.
- Service support is currently macOS-first via launchd. Linux should use the same CLI contract with a future `systemd --user` implementation and linger guidance.

## Known Limits

- A phone cannot maintain an active WebSocket while iOS fully suspends the app. The intended behavior is silent recovery on resume.
- The relay still carries live stream chunks only. The gateway does not yet replay every dropped text/audio delta after a reconnect.
- Durable status is local diagnostic state, not an authoritative event log.

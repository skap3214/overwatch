# Implemented Plans

Plans that have shipped. Kept as historical context for *how* and *why* the current architecture got here. The current shape of the system is in [`../../architecture/`](../../architecture/).

When something here disagrees with the architecture docs, the architecture docs win — these plans are frozen at the moment of implementation and do not get updated as the codebase evolves.

| Plan | Implemented as |
|---|---|
| [voice-harness-bridge-overhaul-2026-05-01](voice-harness-bridge-overhaul-2026-05-01.md) | Pipecat Cloud orchestrator + relay UserChannel + session-host daemon. The big rewrite. See [007](../../architecture/007-post-overhaul-architecture.md). |
| [cli-and-relay-plan-2026-04-09](cli-and-relay-plan-2026-04-09.md) | `overwatch` CLI + Cloudflare Worker relay. Relay was rewritten in the overhaul to drop the in-Mac voice path. |
| [hermes-gateway-plan-2026-04-22](hermes-gateway-plan-2026-04-22.md) | `HermesAgentHarness` + jobs/skills bridges + webhook. See [005](../../architecture/005-hermes-bridge.md). |
| [react-native-app-plan-2026-04-08](react-native-app-plan-2026-04-08.md) | The mobile app. Realtime client was later swapped to the Pipecat RN client + Daily transport in the overhaul. |
| [background-notifications-plan-2026-04-09](background-notifications-plan-2026-04-09.md) | Notification store + scheduler bridges; daemon now feeds `provider_event(overwatch/notification)` to the orchestrator's speak path. |
| [mvp-plan-2026-04-05](mvp-plan-2026-04-05.md) | The original MVP. Largely superseded by the overhaul; kept for context. |
| [realtime-control-plane-plan-2026-04-09](realtime-control-plane-plan-2026-04-09.md) | Mac-side realtime socket. Replaced by the orchestrator + UserChannel + adapter-protocol in the overhaul. Kept for context. |

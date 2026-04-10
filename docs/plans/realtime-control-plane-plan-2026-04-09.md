# Realtime Control Plane Plan

**Date:** 2026-04-09
**Status:** Partially Implemented
**Related Docs:** [../architecture/001-backend-architecture.md](../architecture/001-backend-architecture.md), [../architecture/002-product-vision.md](../architecture/002-product-vision.md), [background-notifications-plan-2026-04-09.md](background-notifications-plan-2026-04-09.md), [pipecat-voice-mode-2026-04-09.md](pipecat-voice-mode-2026-04-09.md), [../insights.md](../insights.md)

## Goal

Move Overwatch from a foreground request/response voice API into a realtime control plane for:

- interactive orchestrator conversations
- background scheduled work
- delegated or spawned long-running agents
- mobile-visible notifications and inbox state
- future push notifications

## Core Design

Adopt a single long-lived bidirectional WebSocket between the mobile client and the Overwatch backend.

Do not make the WebSocket the source of truth.

Instead:

1. persistent stores own truth
2. background workers produce events
3. the WebSocket is the realtime delivery and control layer

This keeps the architecture extensible without forcing every feature through request/response routes.

## Architecture Layers

### 1. Realtime Gateway

A single WebSocket endpoint should handle:

- client hello and resume
- foreground turn control
- background notifications
- delivery acknowledgements
- future tmux and agent status updates

Suggested route:

- `GET /api/v1/ws`

### 2. Persistent Stores

Keep separate stores for separate concerns:

- `turn store`
- `notification store`
- `task store`
- `agent/session registry`
- `memory store`

First version can be JSONL or SQLite.

SQLite is likely the better medium-term choice because the product is moving toward:

- queued background jobs
- resumable notifications
- push eligibility
- state queries across sessions and tasks

### 3. Worker Layer

Background work should not run inside the foreground mobile turn stream.

Workers should own:

- scheduled jobs
- delegated long-running checks
- future sub-agent orchestration
- retry logic
- status transitions

This can start as in-process background runners and later move to a more explicit queue.

### 4. Orchestrator Session

The main Overwatch orchestrator remains a persistent `pi-coding-agent` session.

Its role:

- interpret user intent
- decide what to delegate
- inspect tmux or future runtime state
- update stores
- publish events

It should not be the only place where background work happens.

### 5. Mobile Client

The mobile app becomes a realtime thin client with one transport and multiple local state slices:

- `foreground turn state`
- `background inbox`
- `active tasks`
- `session summaries`
- `connection and replay state`

## Event Model

Use a typed event envelope over the socket.

Suggested shape:

```ts
interface WsEnvelope<T = unknown> {
  id: string;
  type: string;
  createdAt: string;
  payload: T;
}
```

### Client → Server

- `client.hello`
- `client.resume`
- `turn.start`
- `turn.audio_chunk`
- `turn.text`
- `turn.cancel`
- `notification.ack`
- `task.create`
- `task.cancel`

### Server → Client

- `connection.ready`
- `turn.started`
- `turn.transcript`
- `turn.text_delta`
- `turn.audio_chunk`
- `turn.tool_call`
- `turn.done`
- `notification.created`
- `notification.updated`
- `task.updated`
- `session.updated`
- `error`

## State Model

### Foreground turns

Foreground turns are ephemeral realtime interactions.

They need:

- active status
- streaming text
- streaming audio
- cancellation
- final completion

### Notifications

Notifications are durable and replayable.

They need:

- persistence
- seen/acked state
- replay after reconnect
- optional push fanout later

### Tasks

Tasks are long-lived units of background work.

They need:

- queued/running/completed/error states
- ownership and source
- timestamps
- result summaries
- notification links

### Sessions

Sessions are managed resources.

They need:

- current status
- kind such as orchestrator, worker, codex, claude, tmux session
- last known summary
- last activity

## Why This Is Extensible

This shape supports your future roadmap naturally:

### Scheduled work

Scheduler creates or updates `task` records and publishes `notification` events.

### Sub-agents

Sub-agents become task producers and status updaters. They do not require a new transport design.

### Push notifications

Push becomes a second delivery sink for notifications, not a new source of truth.

### tmux observation

tmux watchers can publish `session.updated` or `task.updated` events without coupling themselves to the mobile UI.

### Multiple clients

If you later use iPhone + iPad + web dashboard, all can attach to the same realtime event plane.

## Recommended Storage Evolution

### Phase 1

- JSONL or simple file-backed storage for notifications and tasks

### Phase 2

- SQLite for:
  - notifications
  - task records
  - session registry
  - client ack state

### Phase 3

- optional external queue only if in-process workers become insufficient

Do not start with Redis, Kafka, or a distributed queue.

## Backend Modules

Suggested shape:

```text
src/
  realtime/
    protocol.ts
    socket-server.ts
    client-session.ts
  notifications/
    store.ts
    publisher.ts
  tasks/
    store.ts
    runner.ts
    scheduler-runner.ts
  sessions/
    store.ts
    summarizer.ts
  orchestrator/
    turn-controller.ts
```

## Client Modules

Suggested shape:

```text
overwatch-mobile/src/
  realtime/
    protocol.ts
    socket-client.ts
  stores/
    turn-store.ts
    notifications-store.ts
    tasks-store.ts
    sessions-store.ts
```

## Migration Plan

### Phase 1: websocket foundation

1. add `/api/v1/ws`
2. implement hello, reconnect, ping, and typed envelopes
3. stream foreground turn events over the socket
4. keep current SSE routes temporarily for fallback

### Phase 2: notifications

1. add persistent notification store
2. publish scheduler results as notifications
3. deliver them over the socket
4. add ack semantics

### Phase 3: tasks

1. add task store and task lifecycle
2. move scheduler from prompt injection toward task execution records
3. expose task updates over the socket

### Phase 4: sub-agents

1. let orchestrator spawn or supervise long-running workers
2. workers update task/session state
3. mobile app renders task progress and can later receive push notifications

### Phase 5: retire old transport

1. phase out SSE turn routes after the mobile app is stable on the socket
2. keep simple HTTP endpoints only for health, config, and fallback/debug

## Important Rules

- persistent stores own truth
- background work is not injected into active foreground turns
- notifications are durable and replayable
- socket delivery is resumable, not best-effort only
- transport should carry typed events, not ad hoc strings

## Recommendation

Given the stated product direction, a bidirectional WebSocket now is the right move.

The key is to do it as a control plane:

- one realtime transport
- multiple typed event domains
- durable stores behind it
- background workers publishing into it

That gives Overwatch room to become a genuine mobile orchestrator instead of a voice API with extra features bolted on.

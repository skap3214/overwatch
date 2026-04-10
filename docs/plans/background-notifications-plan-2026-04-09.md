# Background Notifications Plan

**Date:** 2026-04-09
**Status:** Partially Implemented
**Related Docs:** [../architecture/001-backend-architecture.md](../architecture/001-backend-architecture.md), [../architecture/002-product-vision.md](../architecture/002-product-vision.md), [../plans/pipecat-voice-mode-2026-04-09.md](../plans/pipecat-voice-mode-2026-04-09.md), [../insights.md](../insights.md)

## Goal

Extend Overwatch so scheduled jobs and other out-of-band events can reach the mobile app even when there is no active voice turn.

This should solve two current failures:

1. scheduled task results do not reliably surface to the user
2. scheduled work should not be injected into an active foreground assistant turn

## Core Decision

Keep the current request/response turn stream for active conversation, and add a second delivery path for background events.

The architecture should split into:

1. foreground turn channel
2. background notification channel

## Current Problem

Today, TTS and text delivery are coupled to an active `/api/v1/voice-turn` or `/api/v1/text-turn` response stream.

That means:

- a scheduled task can run inside the agent session
- but if no client request is open, there is no output transport to the mobile app
- if the user is mid-turn, there is no clean queueing model for scheduled events

## Proposed Architecture

### 1. Notification Store

Add a persistent store for background events.

Suggested first version:

- `~/.overwatch/notifications.jsonl`

Each event record should include:

- `id`
- `createdAt`
- `kind`
- `title`
- `body`
- `speakableText`
- `status`
- `source`
- optional `metadata`

Supported first kinds:

- `scheduled_task_result`
- `scheduled_task_error`
- `delegated_session_update`
- `system_notice`

This store is append-only for v1, with optional read/ack support layered on top.

### 2. Background Notification Stream

Use the realtime WebSocket control plane for out-of-band delivery.

Behavior:

- the WebSocket handshake sends a notification snapshot
- new notifications arrive as realtime events
- acknowledgements go back over the same socket

This channel must be independent from foreground turn execution semantics even though it shares the same transport.

### 3. Scheduler Execution Model

Do not inject scheduled prompts into the active foreground assistant turn.

Instead:

1. scheduler marks a task as due
2. scheduler creates a background job execution
3. that execution produces a notification event
4. the mobile app receives that event through the notification channel

If the system must serialize work, queue background jobs at the scheduler/worker layer, not inside the foreground conversation stream.

### 4. Mobile Client Behavior

The mobile app should hold two logical channels:

1. foreground turn stream
2. background notification stream

Rules:

- if idle, background notifications may be spoken immediately
- if mid-turn, notifications should be queued in the UI and optionally spoken after the turn finishes
- notifications should still be visible even if TTS is disabled or unavailable

Suggested client state:

- `activeTurn`
- `pendingNotifications`
- `lastDeliveredNotificationId`
- `autoSpeakBackgroundNotifications`

## UX Rules

### Foreground turn

Use the existing `/voice-turn` and `/text-turn` flow.

### Background event

Use the notification stream and inbox.

The user should be able to:

- see the event in a background activity list
- hear it if the app is idle and autoplay is allowed
- review missed items later

### Busy-state behavior

If a scheduled result arrives during an active turn:

- do not interrupt the current assistant response
- queue the notification in the app
- mark it visually as pending
- optionally auto-speak it right after the turn ends

## Minimal Data Model

Suggested TypeScript shape:

```ts
interface NotificationEvent {
  id: string;
  createdAt: string;
  kind:
    | "scheduled_task_result"
    | "scheduled_task_error"
    | "delegated_session_update"
    | "system_notice";
  title: string;
  body: string;
  speakableText?: string;
  status: "new" | "delivered" | "seen" | "acknowledged";
  source: {
    type: "scheduler" | "agent" | "system";
    id?: string;
  };
  metadata?: Record<string, unknown>;
}
```

## Backend Execution Sequence

### Phase 1: notification infrastructure

1. add notification store module
2. add notification publish helper
3. add SSE notifications stream endpoint
4. add list endpoint for initial app hydration

### Phase 2: scheduler integration

1. stop treating `pi.sendUserMessage()` as the only scheduled-task output path
2. add a background execution wrapper for scheduled jobs
3. publish result or error notifications into the store

### Phase 3: mobile integration

1. subscribe to the notification SSE stream from the app
2. render a background inbox
3. add client-side queueing while a turn is active
4. add optional autoplay TTS for idle-state notifications

### Phase 4: hardening

1. reconnect logic for notification SSE
2. event deduplication by notification ID
3. notification retention policy
4. ack or seen-state persistence

## Proposed Repository Changes

```text
src/
  notifications/
    store.ts
    events.ts
    stream.ts
  routes/
    notifications.ts
  scheduler/
    runner.ts   // optional if scheduler execution grows beyond the extension
```

Mobile:

```text
overwatch-mobile/src/
  stores/notifications-store.ts
  hooks/use-notifications-stream.ts
  components/NotificationsPanel.tsx
```

## Important Non-Goals

For this slice, do not:

- redesign the entire voice-turn pipeline
- build full tmux supervision or targeting
- couple notifications to the active foreground SSE stream
- depend on push notifications for v1

## Recommendation

The first implementation should be narrow:

1. notification store
2. notification SSE endpoint
3. mobile subscription and queueing
4. scheduler publishes to notifications

That gives the expected UX with minimal churn:

- scheduled jobs show up on mobile
- busy turns do not get corrupted
- background events are queued instead of dropped

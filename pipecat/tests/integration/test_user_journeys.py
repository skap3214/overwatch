"""User-journey integration tests.

These exercise the orchestrator-side pipeline as a unit, simulating realistic
end-to-end flows from the user's perspective:

  Journey 1 — Voice turn happy path:
    user speaks → STT transcript → bridge dispatches submit_text → fake harness
    streams text_delta + assistant_message + session_end → router emits
    LLMTextFrames (which would feed TTS) → in-flight clears.

  Journey 2 — Steer mid-response:
    user speaks while the previous turn is in flight → bridge emits
    submit_with_steer → harness emits cancel_confirmed → in-flight clears
    on the cancelled correlation → new turn proceeds.

  Journey 3 — Background event coalesces with next user turn:
    monitor fires while idle → registry routes to inject → buffer accumulates
    → next user turn drains buffer into prompt as <context> blocks.

  Journey 4 — Critical alert during quiet period:
    rate_limit provider_event → registry routes to speak (priority 9)
    → user hears the alert.

These journeys use a `FakeAdapterClient` (no relay, no WebSockets) so the
tests stay fast and deterministic.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pipecat.frames.frames import (
    OutputTransportMessageFrame,  # noqa: F401
)
from pipecat.processors.frame_processor import FrameDirection

from overwatch_pipeline.deferred_update_buffer import DeferredUpdateBuffer
from overwatch_pipeline.frames import HarnessEventFrame
from overwatch_pipeline.harness_bridge import HarnessBridgeProcessor
from overwatch_pipeline.harness_event_router import HarnessRouterProcessor
from overwatch_pipeline.harness_router import lookup_config
from overwatch_pipeline.inference_gate import InferenceGateState
from overwatch_pipeline.protocol import (
    AssistantMessage,
    CancelConfirmed,
    HarnessEvent,
    ProviderEvent,
    SessionEnd,
    TextDelta,
    ToolLifecycle,
)

pytestmark = pytest.mark.asyncio


class FakeAdapterClient:
    """In-process adapter that echoes back a scripted sequence of events."""

    def __init__(self) -> None:
        self.commands: list[Any] = []
        self._queue: asyncio.Queue[HarnessEvent] = asyncio.Queue()

    async def submit(self, command: Any) -> None:
        self.commands.append(command)

    def events(self):
        async def _iter():
            while True:
                yield await self._queue.get()

        return _iter()

    async def push_event(self, event: HarnessEvent) -> None:
        await self._queue.put(event)

    async def close(self) -> None:
        pass


def make_pipeline():
    """Construct a bridge + router wired together with shared state."""
    client = FakeAdapterClient()
    gate = InferenceGateState()
    buffer = DeferredUpdateBuffer()
    bridge = HarnessBridgeProcessor(
        adapter_client=client,
        gate_state=gate,
        deferred_buffer=buffer,
        default_target="claude-code",
    )
    router = HarnessRouterProcessor(deferred_buffer=buffer, default_mode="dev")

    pushed_from_router: list = []

    async def fake_push(frame, direction=FrameDirection.DOWNSTREAM):
        pushed_from_router.append((type(frame).__name__, frame))

    router.push_frame = fake_push  # type: ignore[method-assign]
    return bridge, router, client, gate, buffer, pushed_from_router


def wrap(event_cls, **fields) -> HarnessEvent:
    return HarnessEvent.model_validate(event_cls(**fields).model_dump())


# ─── Journey 1 ──────────────────────────────────────────────────────────────


async def test_journey_1_happy_path_voice_turn() -> None:
    """User speaks; harness streams; router speaks each chunk; turn ends."""
    bridge, router, client, gate, buffer, pushed = make_pipeline()

    # User speaks: bridge fires submit_text, marks in-flight.
    await bridge._handle_user_input("what's the weather")
    assert len(client.commands) == 1
    assert client.commands[0].kind == "submit_text"
    correlation = client.commands[0].correlation_id
    assert gate.harness_in_flight

    # Harness streams events back.
    events = [
        wrap(
            TextDelta,
            type="text_delta",
            correlation_id=correlation,
            target="claude-code",
            text="It's ",
            raw=None,
        ),
        wrap(
            TextDelta,
            type="text_delta",
            correlation_id=correlation,
            target="claude-code",
            text="sunny.",
            raw=None,
        ),
        wrap(
            AssistantMessage,
            type="assistant_message",
            correlation_id=correlation,
            target="claude-code",
            text="It's sunny.",
            raw=None,
        ),
        wrap(
            SessionEnd,
            type="session_end",
            correlation_id=correlation,
            target="claude-code",
            subtype="success",
            raw=None,
        ),
    ]

    for event in events:
        await router.process_frame(
            HarnessEventFrame(event=event), FrameDirection.DOWNSTREAM
        )
        bridge._on_event(event)

    # Router should have emitted three LLMTextFrames (2 text_delta, 1 assistant_message)
    # and one OutputTransportMessageFrame (session_end → ui-only).
    text_frames = [p for p in pushed if p[0] == "LLMTextFrame"]
    assert len(text_frames) == 3
    assert any("It's " in p[1].text for p in text_frames)
    assert any("sunny" in p[1].text for p in text_frames)

    server_frames = [p for p in pushed if p[0] == "OutputTransportMessageFrame"]
    assert len(server_frames) == 1

    # Turn cleanup: session_end clears in-flight.
    assert not gate.harness_in_flight


# ─── Journey 2 ──────────────────────────────────────────────────────────────


async def test_journey_2_steer_mid_response() -> None:
    """User speaks while bot is mid-stream; bridge emits submit_with_steer."""
    bridge, router, client, gate, buffer, pushed = make_pipeline()

    # First turn starts.
    await bridge._handle_user_input("first question")
    first_correlation = client.commands[0].correlation_id

    # Harness emits a partial response.
    partial = wrap(
        TextDelta,
        type="text_delta",
        correlation_id=first_correlation,
        target="claude-code",
        text="The ans",
        raw=None,
    )
    await router.process_frame(
        HarnessEventFrame(event=partial), FrameDirection.DOWNSTREAM
    )
    bridge._on_event(partial)

    # User talks again.
    await bridge._handle_user_input("actually never mind, do something else")

    # Bridge emitted submit_with_steer, marked the first correlation as cancel-pending.
    assert len(client.commands) == 2
    second = client.commands[1]
    assert second.kind == "submit_with_steer"
    assert second.payload.cancels_correlation_id == first_correlation
    assert gate.has_cancel_pending

    # Adapter confirms cancel.
    confirm = wrap(
        CancelConfirmed,
        type="cancel_confirmed",
        correlation_id=first_correlation,
        target="claude-code",
    )
    bridge._on_event(confirm)
    assert not gate.has_cancel_pending

    # Confirm new turn is in flight.
    assert gate.harness_in_flight
    assert bridge._active_correlation_id == second.correlation_id


# ─── Journey 3 ──────────────────────────────────────────────────────────────


async def test_journey_3_background_event_coalesces_with_next_turn() -> None:
    """Monitor fires while idle; buffer accumulates; next user turn drains it."""
    bridge, router, client, _, buffer, _ = make_pipeline()

    # Monitor event arrives while idle. Routes through registry → inject.
    monitor_event = wrap(
        ProviderEvent,
        type="provider_event",
        correlation_id="monitor-1",
        target="overwatch",
        provider="overwatch",
        kind="monitor_fired",
        payload={"message": "spike on api-latency", "metric": 0.95},
        raw=None,
    )
    await router.process_frame(
        HarnessEventFrame(event=monitor_event), FrameDirection.DOWNSTREAM
    )

    # Buffer should now have one entry; nothing was sent to the harness yet.
    assert len(buffer) == 1
    assert client.commands == []

    # User says something later.
    await bridge._handle_user_input("ok continue what we were doing")

    # The submit_text command should include the monitor context.
    assert len(client.commands) == 1
    cmd = client.commands[0]
    text = cmd.payload.text
    assert "<context" in text
    assert "spike on api-latency" in text
    assert text.endswith("ok continue what we were doing")
    assert buffer.is_empty()


# ─── Journey 4 ──────────────────────────────────────────────────────────────


async def test_journey_4_critical_alert_speaks() -> None:
    """A rate_limit event from claude-code routes to speak (priority 9)."""
    _, router, _, _, _, pushed = make_pipeline()

    rate_limit = wrap(
        ProviderEvent,
        type="provider_event",
        correlation_id="t1",
        target="claude-code",
        provider="claude-code",
        kind="rate_limit",
        payload={"reset_at": 1234567890, "message": "Rate limited"},
        raw=None,
    )
    await router.process_frame(
        HarnessEventFrame(event=rate_limit), FrameDirection.DOWNSTREAM
    )

    text_frames = [p for p in pushed if p[0] == "LLMTextFrame"]
    assert len(text_frames) == 1
    assert "Rate limited" in text_frames[0][1].text

    # And the registry priority is high (preempts the bot's current speech).
    cfg = lookup_config(rate_limit.root.model_dump(mode="json"))
    assert cfg.priority >= 7


# ─── Journey 5 ──────────────────────────────────────────────────────────────


async def test_journey_5_tool_lifecycle_flows_to_voice_and_buffer() -> None:
    """Tool start narrated; tool complete buffered for next user turn."""
    _, router, _, _, buffer, pushed = make_pipeline()

    start = wrap(
        ToolLifecycle,
        type="tool_lifecycle",
        correlation_id="t1",
        target="claude-code",
        phase="start",
        name="Read",
        raw=None,
    )
    await router.process_frame(
        HarnessEventFrame(event=start), FrameDirection.DOWNSTREAM
    )
    text_frames = [p for p in pushed if p[0] == "LLMTextFrame"]
    assert len(text_frames) == 1
    assert "Running Read" in text_frames[0][1].text

    complete = wrap(
        ToolLifecycle,
        type="tool_lifecycle",
        correlation_id="t1",
        target="claude-code",
        phase="complete",
        name="Read",
        result="42 lines read",
        raw=None,
    )
    await router.process_frame(
        HarnessEventFrame(event=complete), FrameDirection.DOWNSTREAM
    )
    # Complete routes to inject — appended to buffer, no new audio.
    text_frames_after = [p for p in pushed if p[0] == "LLMTextFrame"]
    assert len(text_frames_after) == 1  # still only one (the start)
    assert len(buffer) == 1


# ─── Journey 6 ──────────────────────────────────────────────────────────────


async def test_journey_6_unknown_provider_event_does_not_speak() -> None:
    """A wholly unmapped provider event must NEVER emit audio (invariant)."""
    _, router, _, _, _, pushed = make_pipeline()

    novel = wrap(
        ProviderEvent,
        type="provider_event",
        correlation_id="t1",
        target="hermes",
        provider="hermes",
        kind="completely_new_event_kind_not_in_registry",
        payload={"message": "this should NOT be spoken aloud"},
        raw=None,
    )
    await router.process_frame(
        HarnessEventFrame(event=novel), FrameDirection.DOWNSTREAM
    )

    # In dev mode, default policy is ui-only → no LLMTextFrame.
    text_frames = [p for p in pushed if p[0] == "LLMTextFrame"]
    assert text_frames == []
    server_frames = [p for p in pushed if p[0] == "OutputTransportMessageFrame"]
    assert len(server_frames) == 1

"""HarnessBridgeProcessor — the only processor that emits HarnessCommands.

Verifies the in-flight decision logic:
- idle harness → submit_text
- in-flight harness → submit_with_steer (with cancel marking)
- buffer drain prepends <context> blocks to the prompt
- inbound HarnessEvents update gate state (session_end clears in_flight,
  cancel_confirmed clears cancel_pending)
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from overwatch_pipeline.deferred_update_buffer import DeferredUpdateBuffer
from overwatch_pipeline.frames import MonitorActionFrame
from overwatch_pipeline.harness_bridge import HarnessBridgeProcessor
from overwatch_pipeline.inference_gate import InferenceGateState
from overwatch_pipeline.protocol import (
    CancelConfirmed,
    HarnessEvent,
    ServerMessage,
    SessionEnd,
    TextDelta,
)

pytestmark = pytest.mark.asyncio


class FakeAdapterClient:
    def __init__(self) -> None:
        self.commands: list[Any] = []
        self._queue: asyncio.Queue[HarnessEvent] = asyncio.Queue()
        self._server_message_queue: asyncio.Queue[ServerMessage] = asyncio.Queue()

    async def submit(self, command: Any) -> None:
        self.commands.append(command)

    def events(self):
        async def _iter():
            while True:
                yield await self._queue.get()

        return _iter()

    def server_messages(self):
        async def _iter():
            while True:
                yield await self._server_message_queue.get()

        return _iter()

    async def push_event(self, event: HarnessEvent) -> None:
        await self._queue.put(event)

    async def push_server_message(self, message: ServerMessage) -> None:
        await self._server_message_queue.put(message)

    async def close(self) -> None:
        pass


def make_bridge() -> tuple[HarnessBridgeProcessor, FakeAdapterClient, InferenceGateState, DeferredUpdateBuffer]:
    client = FakeAdapterClient()
    gate = InferenceGateState()
    buffer = DeferredUpdateBuffer()
    bridge = HarnessBridgeProcessor(
        adapter_client=client,
        gate_state=gate,
        deferred_buffer=buffer,
        default_target="claude-code",
    )
    return bridge, client, gate, buffer


async def test_idle_harness_emits_submit_text() -> None:
    bridge, client, gate, _ = make_bridge()
    assert not gate.harness_in_flight

    await bridge._handle_user_input("what is 2+2")

    assert len(client.commands) == 1
    cmd = client.commands[0]
    assert cmd.kind == "submit_text"
    assert cmd.target == "claude-code"
    assert cmd.payload.text == "what is 2+2"
    assert gate.harness_in_flight


async def test_final_voice_turn_submits_while_old_bot_audio_is_speaking() -> None:
    bridge, client, gate, _ = make_bridge()
    gate.update_bot_speaking(True)

    await bridge._handle_user_input("interruption question", source="voice")

    assert len(client.commands) == 1
    cmd = client.commands[0]
    assert cmd.kind == "submit_text"
    assert cmd.payload.text == "interruption question"
    assert gate.harness_in_flight


async def test_final_voice_turn_submits_during_post_tts_cooldown() -> None:
    bridge, client, gate, _ = make_bridge()
    gate.cooldown_seconds = 10.0
    gate.update_bot_speaking(True)
    gate.update_bot_speaking(False)
    assert gate.can_run_now() is False

    await bridge._handle_user_input("follow-up after barge in", source="voice")

    assert len(client.commands) == 1
    cmd = client.commands[0]
    assert cmd.kind == "submit_text"
    assert cmd.payload.text == "follow-up after barge in"


async def test_in_flight_harness_emits_submit_with_steer() -> None:
    bridge, client, gate, _ = make_bridge()
    # Simulate an in-flight turn.
    await bridge._handle_user_input("first message")
    first_id = client.commands[0].correlation_id
    assert gate.harness_in_flight

    # User sends another message while in-flight — should steer.
    await bridge._handle_user_input("steer the conversation")

    assert len(client.commands) == 2
    second = client.commands[1]
    assert second.kind == "submit_with_steer"
    assert second.payload.cancels_correlation_id == first_id
    assert second.payload.text == "steer the conversation"
    # The cancel id is now pending.
    assert gate.has_cancel_pending


async def test_split_voice_transcript_preemption_preserves_first_fragment() -> None:
    bridge, client, gate, _ = make_bridge()

    await bridge._handle_user_input("first sentence with setup", source="voice")
    first_id = client.commands[0].correlation_id
    assert gate.harness_in_flight

    await bridge._handle_user_input("second sentence with the actual ask", source="voice")

    assert len(client.commands) == 2
    second = client.commands[1]
    assert second.kind == "submit_with_steer"
    assert second.payload.cancels_correlation_id == first_id
    assert (
        second.payload.text
        == "first sentence with setup\nsecond sentence with the actual ask"
    )


async def test_split_voice_transcript_keeps_accumulating_across_repeated_splits() -> None:
    bridge, client, _, _ = make_bridge()

    await bridge._handle_user_input("part one", source="voice")
    await bridge._handle_user_input("part two", source="voice")
    await bridge._handle_user_input("part three", source="voice")

    assert len(client.commands) == 3
    assert client.commands[2].kind == "submit_with_steer"
    assert client.commands[2].payload.text == "part one\npart two\npart three"


async def test_typed_preemption_does_not_inherit_prior_voice_fragment() -> None:
    bridge, client, _, _ = make_bridge()

    await bridge._handle_user_input("voice setup", source="voice")
    await bridge._handle_user_input("typed replacement")

    assert len(client.commands) == 2
    second = client.commands[1]
    assert second.kind == "submit_with_steer"
    assert second.payload.text == "typed replacement"


async def test_held_voice_fragments_append_instead_of_last_write_wins() -> None:
    bridge, _, gate, _ = make_bridge()
    gate.update_user_speaking(True)

    await bridge._handle_user_input("first held fragment", source="voice")
    await bridge._handle_user_input("second held fragment", source="voice")

    pending = bridge._pending_user_input.peek()  # noqa: SLF001
    assert pending is not None
    assert pending.text == "first held fragment\nsecond held fragment"
    assert pending.source == "voice"


async def test_buffer_drain_prepends_to_prompt() -> None:
    bridge, client, _, buffer = make_bridge()
    buffer.append(
        text="spike detected on api-latency",
        source="monitor",
        kind="alert",
        priority=5,
    )
    buffer.append(
        text="auth.ts changed",
        source="claude-code",
        kind="files_persisted",
        priority=2,
    )
    assert len(buffer) == 2

    await bridge._handle_user_input("ok continue")

    assert len(client.commands) == 1
    text = client.commands[0].payload.text
    # Both context blocks present, sorted high → low priority.
    assert "<context" in text
    assert "spike detected" in text
    assert "auth.ts changed" in text
    assert text.endswith("ok continue")
    # Buffer drained.
    assert buffer.is_empty()


async def test_monitor_action_bypasses_user_turn_and_submits_manage_monitor() -> None:
    bridge, client, gate, _ = make_bridge()

    await bridge._handle_monitor_action(
        MonitorActionFrame(
            request_id="req-1",
            action="run_now",
            monitor_id="job-1",
        )
    )

    assert len(client.commands) == 1
    command = client.commands[0]
    assert command.kind == "manage_monitor"
    assert command.payload.request_id == "req-1"
    assert command.payload.action.value == "run_now"
    assert command.payload.monitor_id == "job-1"
    assert not gate.harness_in_flight


async def test_session_end_event_clears_in_flight() -> None:
    bridge, _, gate, _ = make_bridge()
    await bridge._handle_user_input("hello")
    assert gate.harness_in_flight
    correlation_id = bridge._active_correlation_id

    end_event = HarnessEvent.model_validate(
        SessionEnd(
            type="session_end",
            correlation_id=correlation_id,
            target="claude-code",
            subtype="success",
            raw=None,
        ).model_dump(),
    )
    bridge._on_event(end_event)

    assert not gate.harness_in_flight
    assert bridge._active_correlation_id is None


async def test_cancel_confirmed_event_clears_cancel_pending() -> None:
    bridge, _, gate, _ = make_bridge()
    await bridge._handle_user_input("first")
    first_id = bridge._active_correlation_id
    assert first_id is not None
    await bridge._handle_user_input("steer")
    assert gate.has_cancel_pending
    assert first_id in gate._cancel_pending  # noqa: SLF001

    confirm = HarnessEvent.model_validate(
        CancelConfirmed(
            type="cancel_confirmed",
            correlation_id=first_id,
            target="claude-code",
        ).model_dump(),
    )
    bridge._on_event(confirm)

    assert not gate.has_cancel_pending


async def test_text_delta_event_does_not_clear_in_flight() -> None:
    bridge, _, gate, _ = make_bridge()
    await bridge._handle_user_input("hello")
    correlation_id = bridge._active_correlation_id

    text_event = HarnessEvent.model_validate(
        TextDelta(
            type="text_delta",
            correlation_id=correlation_id,
            target="claude-code",
            text="streaming",
            raw=None,
        ).model_dump(),
    )
    bridge._on_event(text_event)

    # Text deltas should not affect in-flight state.
    assert gate.harness_in_flight
    assert bridge._active_correlation_id == correlation_id

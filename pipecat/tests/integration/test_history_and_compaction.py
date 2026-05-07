from __future__ import annotations

import pytest
from _harness import build_test_pipeline
from pipecat.processors.frame_processor import FrameDirection

from overwatch_pipeline.frames import HarnessEventFrame
from overwatch_pipeline.protocol import HarnessEvent

pytestmark = pytest.mark.asyncio


def event(payload: dict) -> HarnessEvent:
    return HarnessEvent.model_validate(payload)


async def test_compaction_busy_blocks_commands_but_holds_user_input() -> None:
    ctx = build_test_pipeline()
    ctx.bridge._on_event(
        event(
            {
                "type": "agent_busy",
                "phase": "compaction",
                "reason": "token_budget",
                "correlation_id": "turn-5",
                "target": "pi",
            }
        )
    )

    await ctx.bridge._handle_user_input("use the newer plan")
    await ctx.bridge.submit_cancel()

    assert ctx.client.commands == []
    assert ctx.gate.harness_busy
    assert ctx.gate.harness_busy_reason == "token_budget"
    assert ctx.pending_user_input.peek().text == "use the newer plan"


async def test_agent_idle_admits_pending_user_input_with_deferred_context() -> None:
    ctx = build_test_pipeline()
    ctx.deferred_buffer.append(
        text="monitor saw the deploy finish",
        source="overwatch",
        kind="monitor_fired",
        priority=5,
    )
    ctx.bridge._on_event(
        event(
            {
                "type": "agent_busy",
                "phase": "compaction",
                "correlation_id": "turn-5",
                "target": "pi",
            }
        )
    )
    await ctx.bridge._handle_user_input("continue with the smoke test")
    assert len(ctx.deferred_buffer) == 1

    ctx.bridge._on_event(
        event(
            {
                "type": "agent_idle",
                "correlation_id": "turn-5",
                "target": "pi",
            }
        )
    )
    await ctx.run_until(lambda: len(ctx.client.commands) == 1)

    cmd = ctx.client.commands[0]
    assert cmd.kind == "submit_text"
    assert "monitor saw the deploy finish" in cmd.payload.text
    assert cmd.payload.text.endswith("continue with the smoke test")
    assert ctx.pending_user_input.is_empty()
    assert ctx.deferred_buffer.is_empty()


async def test_busy_window_user_input_is_last_write_wins() -> None:
    ctx = build_test_pipeline()
    ctx.gate.update_harness_busy(True, reason="compaction")

    await ctx.bridge._handle_user_input("old request")
    await ctx.bridge._handle_user_input("new request")

    assert ctx.client.commands == []
    assert ctx.pending_user_input.peek().text == "new request"


async def test_agent_busy_and_idle_are_ui_only_events() -> None:
    ctx = build_test_pipeline()
    for payload in (
        {
            "type": "agent_busy",
            "phase": "compaction",
            "correlation_id": "turn-5",
            "target": "pi",
        },
        {
            "type": "agent_idle",
            "correlation_id": "turn-5",
            "target": "pi",
        },
    ):
        await ctx.router.process_frame(
            HarnessEventFrame(event=event(payload)),
            FrameDirection.DOWNSTREAM,
        )

    assert ctx.recorder.names() == [
        "RTVIServerMessageFrame",
        "RTVIServerMessageFrame",
    ]


async def test_deferred_context_drains_when_user_preempts_old_bot_audio() -> None:
    ctx = build_test_pipeline()
    ctx.deferred_buffer.append(
        text="tool completed",
        source="claude-code",
        kind="tool_lifecycle",
        priority=4,
    )
    ctx.gate.update_bot_speaking(True)

    await ctx.bridge._handle_user_input("what changed")

    assert len(ctx.client.commands) == 1
    assert len(ctx.deferred_buffer) == 0
    assert ctx.pending_user_input.peek() is None
    assert "tool completed" in ctx.client.commands[0].payload.text

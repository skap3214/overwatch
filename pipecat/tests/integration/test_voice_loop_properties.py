from __future__ import annotations

import random

import pytest
from _harness import build_test_pipeline
from pipecat.processors.frame_processor import FrameDirection

from overwatch_pipeline.frames import HarnessEventFrame
from overwatch_pipeline.protocol import HarnessEvent

pytestmark = pytest.mark.asyncio


def event(payload: dict) -> HarnessEvent:
    return HarnessEvent.model_validate(payload)


async def test_state_machine_invariants_under_deterministic_interleavings() -> None:
    rng = random.Random(20260503)

    for _case in range(25):
        ctx = build_test_pipeline()
        active_ids: list[str] = []

        for step in range(30):
            action = rng.choice(
                [
                    "user_text",
                    "agent_busy",
                    "agent_idle",
                    "text_delta",
                    "session_end",
                    "unknown_event",
                ]
            )

            before_commands = len(ctx.client.commands)

            if action == "user_text":
                await ctx.bridge._handle_user_input(f"user request {step}")
                if len(ctx.client.commands) > before_commands:
                    active_ids.append(ctx.client.commands[-1].correlation_id)
            elif action == "agent_busy":
                ctx.bridge._on_event(
                    event(
                        {
                            "type": "agent_busy",
                            "phase": "compaction",
                            "correlation_id": active_ids[-1] if active_ids else "idle",
                            "target": "pi",
                        }
                    )
                )
            elif action == "agent_idle":
                ctx.bridge._on_event(
                    event(
                        {
                            "type": "agent_idle",
                            "correlation_id": active_ids[-1] if active_ids else "idle",
                            "target": "pi",
                        }
                    )
                )
                await ctx.run_until(
                    lambda ctx=ctx: not ctx.gate.harness_busy,
                    timeout=0.2,
                )
            elif action == "text_delta" and active_ids:
                await ctx.router.process_frame(
                    HarnessEventFrame(
                        event=event(
                            {
                                "type": "text_delta",
                                "correlation_id": active_ids[-1],
                                "target": "claude-code",
                                "text": "ok",
                            }
                        )
                    ),
                    FrameDirection.DOWNSTREAM,
                )
            elif action == "session_end" and active_ids:
                cid = active_ids.pop()
                ctx.bridge._on_event(
                    event(
                        {
                            "type": "session_end",
                            "correlation_id": cid,
                            "target": "claude-code",
                            "subtype": "success",
                        }
                    )
                )
            elif action == "unknown_event":
                await ctx.router.process_frame(
                    HarnessEventFrame(
                        event=event(
                            {
                                "type": "provider_event",
                                "correlation_id": f"unknown-{step}",
                                "target": "hermes",
                                "provider": "hermes",
                                "kind": f"novel-{step}",
                                "payload": {"message": "must not speak"},
                            }
                        )
                    ),
                    FrameDirection.DOWNSTREAM,
                )

            if ctx.gate.harness_busy:
                assert len(ctx.client.commands) == before_commands or action != "user_text"
            assert ctx.recorder.count("TTSSpeakFrame") == 0
            assert ctx.recorder.count("LLMFullResponseStartFrame") >= ctx.recorder.count(
                "LLMFullResponseEndFrame"
            )


async def test_pending_user_input_never_becomes_deferred_xml_context() -> None:
    ctx = build_test_pipeline()
    ctx.gate.update_harness_busy(True, reason="compaction")
    await ctx.bridge._handle_user_input("do the thing")
    ctx.gate.update_harness_busy(False)

    assert await ctx.bridge.drain_pending_user_input()
    text = ctx.client.commands[0].payload.text
    assert "<context" not in text
    assert text == "do the thing"

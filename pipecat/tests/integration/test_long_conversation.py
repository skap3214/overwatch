from __future__ import annotations

import pytest
from _harness import build_test_pipeline
from pipecat.processors.frame_processor import FrameDirection

from overwatch_pipeline.frames import HarnessEventFrame
from overwatch_pipeline.protocol import HarnessEvent
from overwatch_pipeline.settings import Settings


def event(payload: dict) -> HarnessEvent:
    return HarnessEvent.model_validate(payload)


@pytest.mark.asyncio
async def test_twenty_turn_smoke_no_gate_or_cancel_leaks() -> None:
    ctx = build_test_pipeline()

    for turn in range(20):
        await ctx.bridge._handle_user_input(f"turn {turn}")
        cmd = ctx.client.commands[-1]
        assert cmd.kind == "submit_text"
        assert ctx.gate.harness_in_flight

        for i in range(5):
            await ctx.router.process_frame(
                HarnessEventFrame(
                    event=event(
                        {
                            "type": "text_delta",
                            "correlation_id": cmd.correlation_id,
                            "target": "claude-code",
                            "text": f"chunk {turn}.{i} ",
                        }
                    )
                ),
                FrameDirection.DOWNSTREAM,
            )
        terminal = event(
            {
                "type": "assistant_message",
                "correlation_id": cmd.correlation_id,
                "target": "claude-code",
                "text": "done",
            }
        )
        await ctx.router.process_frame(
            HarnessEventFrame(event=terminal),
            FrameDirection.DOWNSTREAM,
        )
        ctx.bridge._on_event(
            event(
                {
                    "type": "session_end",
                    "correlation_id": cmd.correlation_id,
                    "target": "claude-code",
                    "subtype": "success",
                }
            )
        )

        assert not ctx.gate.harness_in_flight
        assert not ctx.gate.has_cancel_pending
        assert ctx.bridge._active_correlation_id is None  # noqa: SLF001
        assert ctx.pending_user_input.is_empty()

    assert len(ctx.client.commands) == 20
    assert ctx.recorder.count("LLMFullResponseStartFrame") == 20
    assert ctx.recorder.count("LLMFullResponseEndFrame") == 20


def test_stt_endpointing_defaults_are_sensitive_pause_safe() -> None:
    settings = Settings(deepgram_api_key="x", cartesia_api_key="y")

    assert settings.stt_endpointing_ms == 1000
    assert settings.stt_utterance_end_ms == 2000


def test_pipeline_factory_order_matches_voice_loop_contract() -> None:
    ctx = build_test_pipeline()
    names = [type(processor).__name__ for processor in ctx.factory.processors]

    assert names == [
        "PassthroughProcessor",
        "TypedInputDecoder",
        "InterruptionEmitter",
        "InterruptionTrace",
        "PassthroughProcessor",
        "IdleReportProcessor",
        "PreLLMInferenceGate",
        "HarnessBridgeProcessor",
        "HarnessRouterProcessor",
        "PostLLMInferenceGate",
        "SayTextVoiceGuard",
        "InterruptionTrace",
        "PassthroughProcessor",
        "InterruptionTrace",
        "PassthroughProcessor",
    ]

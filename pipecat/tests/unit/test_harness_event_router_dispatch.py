"""HarnessRouterProcessor — turns HarnessEventFrames into outbound frames.

Verifies the registry-driven dispatch rules from §4.4:
- speak voice action emits an LLM text frame, properly bracketed by
  LLMFullResponseStart/End so Cartesia (and any LLM-aware TTS) flushes
  the audio without waiting for the next turn
- one-shot speakables (tool phrases, errors) emit `TTSSpeakFrame`
- inject voice action appends to the deferred buffer (no audio)
- ui-only voice action emits a server message frame
- session_end finalizes any open turn before forwarding the ui-only marker
- drop voice action produces nothing
- unknown events fall back to default policy (ui-only in dev, never speak)
"""

from __future__ import annotations

import pytest
from pipecat.processors.frame_processor import FrameDirection

from overwatch_pipeline.deferred_update_buffer import DeferredUpdateBuffer
from overwatch_pipeline.frames import HarnessEventFrame
from overwatch_pipeline.harness_event_router import HarnessRouterProcessor
from overwatch_pipeline.protocol import (
    AssistantMessage,
    ErrorEvent,
    HarnessEvent,
    ProviderEvent,
    SessionEnd,
    TextDelta,
    ToolLifecycle,
)

pytestmark = pytest.mark.asyncio


def make_router(default_mode: str = "dev") -> tuple[HarnessRouterProcessor, DeferredUpdateBuffer, list]:
    buffer = DeferredUpdateBuffer()
    router = HarnessRouterProcessor(deferred_buffer=buffer, default_mode=default_mode)
    pushed: list = []

    async def fake_push(frame, direction=FrameDirection.DOWNSTREAM):
        pushed.append((type(frame).__name__, frame))

    router.push_frame = fake_push  # type: ignore[method-assign]
    return router, buffer, pushed


def _text_delta(text: str, correlation_id: str = "t1") -> HarnessEventFrame:
    event = HarnessEvent.model_validate(
        TextDelta(
            type="text_delta",
            correlation_id=correlation_id,
            target="claude-code",
            text=text,
            raw=None,
        ).model_dump(),
    )
    return HarnessEventFrame(event=event)


def _assistant_message(text: str, correlation_id: str = "t1") -> HarnessEventFrame:
    event = HarnessEvent.model_validate(
        AssistantMessage(
            type="assistant_message",
            correlation_id=correlation_id,
            target="claude-code",
            text=text,
            raw=None,
        ).model_dump(),
    )
    return HarnessEventFrame(event=event)


def _session_end(correlation_id: str = "t1") -> HarnessEventFrame:
    event = HarnessEvent.model_validate(
        SessionEnd(
            type="session_end",
            correlation_id=correlation_id,
            target="claude-code",
            subtype="success",
            raw=None,
        ).model_dump(),
    )
    return HarnessEventFrame(event=event)


# ─── streaming bracketed turns ────────────────────────────────────────────


async def test_first_text_delta_opens_turn_and_pushes_text() -> None:
    router, _, pushed = make_router()
    await router._dispatch(_text_delta("Hello "))

    # First delta in a turn opens the LLM bracket then pushes the text.
    # No RTVIServerMessageFrame: streaming text reaches the mobile via
    # RTVI's auto-relay of LLMTextFrame as `bot-llm-text`. Forwarding here
    # would double the chunk in the transcript.
    names = [n for n, _ in pushed]
    assert names == ["LLMFullResponseStartFrame", "LLMTextFrame"]
    assert pushed[1][1].text == "Hello "


async def test_subsequent_text_deltas_in_same_turn_only_push_text() -> None:
    router, _, pushed = make_router()
    await router._dispatch(_text_delta("Hello "))
    await router._dispatch(_text_delta("world."))

    names = [n for n, _ in pushed]
    # Start frame fires once; each delta pushes only LLMTextFrame.
    assert names == [
        "LLMFullResponseStartFrame",
        "LLMTextFrame",
        "LLMTextFrame",
    ]


async def test_assistant_message_after_deltas_closes_turn_without_double_emit() -> None:
    router, _, pushed = make_router()
    await router._dispatch(_text_delta("Hello "))
    await router._dispatch(_text_delta("world."))
    # assistant_message is the Tier-1 terminal; coalesces with text_delta
    # so its text isn't re-emitted, just closes the bracket.
    await router._dispatch(_assistant_message("Hello world."))

    names = [n for n, _ in pushed]
    assert names == [
        "LLMFullResponseStartFrame",
        "LLMTextFrame",
        "LLMTextFrame",
        "LLMFullResponseEndFrame",
    ]


async def test_assistant_message_alone_brackets_full_response() -> None:
    router, _, pushed = make_router()
    await router._dispatch(_assistant_message("Done."))

    names = [n for n, _ in pushed]
    assert names == [
        "LLMFullResponseStartFrame",
        "LLMTextFrame",
        "LLMFullResponseEndFrame",
    ]
    assert pushed[1][1].text == "Done."


async def test_session_end_closes_turn_before_ui_only_marker() -> None:
    router, _, pushed = make_router()
    await router._dispatch(_text_delta("Hello "))
    await router._dispatch(_session_end())

    names = [n for n, _ in pushed]
    # End frame must come BEFORE the session_end RTVIServerMessageFrame so
    # TTS flushes the buffered chunks before we tell the UI the turn ended.
    assert names == [
        "LLMFullResponseStartFrame",
        "LLMTextFrame",
        "LLMFullResponseEndFrame",
        "RTVIServerMessageFrame",
    ]


async def test_new_correlation_id_closes_prior_open_turn() -> None:
    router, _, pushed = make_router()
    await router._dispatch(_text_delta("Hi", correlation_id="t1"))
    # Different correlation — the prior turn never got a terminal, so the
    # router auto-closes it before opening the new one.
    await router._dispatch(_text_delta("Bye", correlation_id="t2"))

    names = [n for n, _ in pushed]
    assert names == [
        "LLMFullResponseStartFrame",
        "LLMTextFrame",
        "LLMFullResponseEndFrame",
        "LLMFullResponseStartFrame",
        "LLMTextFrame",
    ]


# ─── one-shot speakables ──────────────────────────────────────────────────


async def test_session_end_alone_routes_to_ui_only_no_brackets() -> None:
    router, _, pushed = make_router()
    await router._dispatch(_session_end())
    assert len(pushed) == 1
    assert pushed[0][0] == "RTVIServerMessageFrame"


async def test_tool_lifecycle_complete_routes_to_inject_and_ui() -> None:
    """Tool complete is silent (inject for next-prompt context) AND visible
    in the UI so the user sees what happened."""
    router, buffer, pushed = make_router()
    event = HarnessEvent.model_validate(
        ToolLifecycle(
            type="tool_lifecycle",
            correlation_id="t1",
            target="claude-code",
            phase="complete",
            name="Read",
            result={"path": "auth.ts"},
            raw=None,
        ).model_dump(),
    )
    await router._dispatch(HarnessEventFrame(event=event))
    # inject = no audio frame; buffer entry created.
    names = [n for n, _ in pushed]
    assert names == ["RTVIServerMessageFrame"]
    assert len(buffer) == 1


async def test_tool_lifecycle_start_is_silent_and_ui_visible() -> None:
    """Tool start is now ui-only — silent in audio, visible in UI."""
    router, _, pushed = make_router()
    event = HarnessEvent.model_validate(
        ToolLifecycle(
            type="tool_lifecycle",
            correlation_id="t1",
            target="claude-code",
            phase="start",
            name="Bash",
            raw=None,
        ).model_dump(),
    )
    await router._dispatch(HarnessEventFrame(event=event))
    names = [n for n, _ in pushed]
    # ui-only — single RTVIServerMessageFrame, no TTS frames.
    assert names == ["RTVIServerMessageFrame"]


async def test_error_event_speaks_and_forwards_to_ui() -> None:
    router, _, pushed = make_router()
    event = HarnessEvent.model_validate(
        ErrorEvent(
            type="error",
            correlation_id="t1",
            target="claude-code",
            message="auth expired",
            raw=None,
        ).model_dump(),
    )
    await router._dispatch(HarnessEventFrame(event=event))
    names = [n for n, _ in pushed]
    assert names == ["TTSSpeakFrame", "RTVIServerMessageFrame"]
    assert pushed[0][1].text == "auth expired"


async def test_provider_event_speak_uses_tts_speak_frame_and_forwards() -> None:
    router, _, pushed = make_router()
    event = HarnessEvent.model_validate(
        ProviderEvent(
            type="provider_event",
            correlation_id="t1",
            target="claude-code",
            provider="claude-code",
            kind="rate_limit",
            payload={"reset_at": 1234567890, "message": "Hit your limit"},
            raw=None,
        ).model_dump(),
    )
    await router._dispatch(HarnessEventFrame(event=event))
    names = [n for n, _ in pushed]
    assert names == ["TTSSpeakFrame", "RTVIServerMessageFrame"]
    assert "Hit your limit" in pushed[0][1].text


# ─── default policy ───────────────────────────────────────────────────────


async def test_unknown_provider_event_dev_default_ui_only() -> None:
    router, _, pushed = make_router(default_mode="dev")
    event = HarnessEvent.model_validate(
        ProviderEvent(
            type="provider_event",
            correlation_id="t1",
            target="claude-code",
            provider="hermes",
            kind="something_unmapped_yet",
            payload={"foo": 1},
            raw=None,
        ).model_dump(),
    )
    await router._dispatch(HarnessEventFrame(event=event))
    assert len(pushed) == 1
    assert pushed[0][0] == "RTVIServerMessageFrame"


async def test_unknown_provider_event_prod_default_drop() -> None:
    router, _, pushed = make_router(default_mode="prod")
    event = HarnessEvent.model_validate(
        ProviderEvent(
            type="provider_event",
            correlation_id="t1",
            target="claude-code",
            provider="hermes",
            kind="totally_unknown",
            payload={},
            raw=None,
        ).model_dump(),
    )
    await router._dispatch(HarnessEventFrame(event=event))
    # drop = nothing pushed
    assert pushed == []


async def test_speak_event_with_no_text_does_not_emit_audio() -> None:
    """A speak-routed event with no text content emits no audio frames AND
    no LLM brackets — but still surfaces to the UI so the transcript
    reflects that something arrived (e.g. a delta with whitespace-only
    payload from a provider that buffers oddly)."""
    router, _, pushed = make_router()
    event = HarnessEvent.model_validate(
        TextDelta(
            type="text_delta",
            correlation_id="t1",
            target="claude-code",
            text="   ",  # whitespace-only
            raw=None,
        ).model_dump(),
    )
    await router._dispatch(HarnessEventFrame(event=event))
    names = [n for n, _ in pushed]
    # No audio + no LLM-bracket frames; only the UI mirror.
    assert names == ["RTVIServerMessageFrame"]

"""HarnessRouterProcessor — turns HarnessEventFrames into outbound frames.

Verifies the registry-driven dispatch rules from §4.4:
- speak voice action emits an LLM text frame
- inject voice action appends to the deferred buffer (no audio)
- ui-only voice action emits a server message frame
- drop voice action produces nothing
- unknown events fall back to default policy (ui-only in dev, never speak)
"""

from __future__ import annotations

import pytest
from pipecat.frames.frames import LLMTextFrame
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


async def test_text_delta_routes_to_speak() -> None:
    router, _, pushed = make_router()
    event = HarnessEvent.model_validate(
        TextDelta(
            type="text_delta",
            correlation_id="t1",
            target="claude-code",
            text="Hello world",
            raw=None,
        ).model_dump(),
    )
    await router._dispatch(HarnessEventFrame(event=event))

    assert len(pushed) == 1
    name, frame = pushed[0]
    assert name == "LLMTextFrame"
    assert isinstance(frame, LLMTextFrame)
    assert frame.text == "Hello world"


async def test_assistant_message_routes_to_speak() -> None:
    router, _, pushed = make_router()
    event = HarnessEvent.model_validate(
        AssistantMessage(
            type="assistant_message",
            correlation_id="t1",
            target="claude-code",
            text="Done.",
            raw=None,
        ).model_dump(),
    )
    await router._dispatch(HarnessEventFrame(event=event))
    assert pushed[0][0] == "LLMTextFrame"


async def test_session_end_routes_to_ui_only() -> None:
    router, _, pushed = make_router()
    event = HarnessEvent.model_validate(
        SessionEnd(
            type="session_end",
            correlation_id="t1",
            target="claude-code",
            subtype="success",
            raw=None,
        ).model_dump(),
    )
    await router._dispatch(HarnessEventFrame(event=event))
    assert len(pushed) == 1
    assert pushed[0][0] == "OutputTransportMessageFrame"


async def test_tool_lifecycle_complete_routes_to_inject() -> None:
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
    # inject = no frame pushed; buffer entry created
    assert pushed == []
    assert len(buffer) == 1


async def test_tool_lifecycle_start_routes_to_speak_with_default_text() -> None:
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
    assert pushed[0][0] == "LLMTextFrame"
    assert "Bash" in pushed[0][1].text


async def test_error_event_routes_to_speak() -> None:
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
    assert pushed[0][0] == "LLMTextFrame"
    assert pushed[0][1].text == "auth expired"


async def test_claude_code_rate_limit_routes_to_speak() -> None:
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
    assert pushed[0][0] == "LLMTextFrame"
    assert "Hit your limit" in pushed[0][1].text


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
    assert pushed[0][0] == "OutputTransportMessageFrame"


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


async def test_speak_event_with_no_text_does_not_push() -> None:
    """A speak-routed event with no text content silently does nothing
    (logs at debug). Prevents empty TTS calls."""
    router, _, pushed = make_router()
    # text_delta with empty string still has text=""; lookup_config returns speak
    # but the extracted text is "" which should not push.
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
    assert pushed == []

"""Tests for the codegenned protocol pydantic models."""

from __future__ import annotations

from overwatch_pipeline.protocol import (
    PROTOCOL_VERSION,
    Cancel,
    HarnessEvent,
    ProviderEvent,
    SubmitText,
    SubmitWithSteer,
    TextDelta,
)


def test_protocol_version_is_string() -> None:
    assert isinstance(PROTOCOL_VERSION, str)
    assert "." in PROTOCOL_VERSION


def test_submit_text_validates() -> None:
    cmd = SubmitText(
        kind="submit_text",
        correlation_id="abc",
        target="claude-code",
        payload={"text": "hello"},
    )
    assert cmd.kind == "submit_text"
    assert cmd.payload.text == "hello"


def test_submit_with_steer_requires_cancels_correlation_id() -> None:
    cmd = SubmitWithSteer(
        kind="submit_with_steer",
        correlation_id="abc",
        target="claude-code",
        payload={"text": "hi", "cancels_correlation_id": "old"},
    )
    assert cmd.payload.cancels_correlation_id == "old"


def test_cancel_command() -> None:
    cmd = Cancel(
        kind="cancel",
        correlation_id="new",
        target="claude-code",
        payload={"target_correlation_id": "old"},
    )
    assert cmd.payload.target_correlation_id == "old"


def test_harness_event_root_model_discriminates() -> None:
    text = TextDelta(
        type="text_delta",
        correlation_id="abc",
        target="claude-code",
        text="hello",
        raw=None,
    )
    # RootModel wrap
    evt = HarnessEvent.model_validate(text.model_dump())
    assert evt.root.type == "text_delta"


def test_provider_event_passthrough() -> None:
    pe = ProviderEvent(
        type="provider_event",
        correlation_id="abc",
        target="claude-code",
        provider="claude-code",
        kind="rate_limit",
        payload={"reset_at": 1234567890},
        raw=None,
    )
    assert pe.kind == "rate_limit"
    assert pe.payload == {"reset_at": 1234567890}

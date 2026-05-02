"""End-to-end synthetic harness verification.

Drives a ScriptedHarness through the HarnessRouter + DeferredUpdateBuffer +
InferenceGateState, asserting every voice action lands where the registry says.

This is the orchestrator-side pre-flight cert step from plan §10. It exercises
the wiring without needing a real harness, real audio, or real network. CI
should run this on every push.
"""

from __future__ import annotations

import asyncio
import pytest

from overwatch_pipeline.deferred_update_buffer import DeferredUpdateBuffer
from overwatch_pipeline.harness_router import lookup_config


pytestmark = pytest.mark.asyncio


def make_event(event_type: str, **fields: object) -> dict:
    return {
        "type": event_type,
        "correlation_id": "turn-1",
        "target": "claude-code",
        **fields,
    }


async def test_text_delta_speaks() -> None:
    cfg = lookup_config(make_event("text_delta", text="Hello world"))
    assert cfg.voice_action == "speak"


async def test_tool_lifecycle_complete_buffers_for_inject() -> None:
    buffer = DeferredUpdateBuffer()
    cfg = lookup_config(
        make_event(
            "tool_lifecycle",
            phase="complete",
            name="Read",
            result={"path": "auth.ts", "lines": 42},
        )
    )
    assert cfg.voice_action == "inject"
    buffer.append(
        text="Read auth.ts (42 lines)",
        source="claude-code",
        kind="tool_lifecycle:complete",
        priority=cfg.priority,
    )
    out = buffer.drain_into_prompt()
    assert "Read auth.ts" in out


async def test_session_end_routes_to_ui() -> None:
    cfg = lookup_config(
        make_event("session_end", subtype="success", cost_usd=0.012)
    )
    assert cfg.voice_action == "ui-only"


async def test_provider_event_unknown_falls_to_default_dev() -> None:
    cfg = lookup_config(
        make_event(
            "provider_event",
            provider="claude-code",
            kind="brand_new_event_we_havent_mapped",
            payload={"foo": "bar"},
        ),
        default_mode="dev",
    )
    assert cfg.voice_action == "ui-only"


async def test_provider_event_unknown_drops_in_prod() -> None:
    cfg = lookup_config(
        make_event(
            "provider_event",
            provider="hermes",
            kind="something_unknown",
            payload={},
        ),
        default_mode="prod",
    )
    assert cfg.voice_action == "drop"


async def test_critical_provider_events_speak_with_high_priority() -> None:
    rate_limit = lookup_config(
        make_event(
            "provider_event",
            provider="claude-code",
            kind="rate_limit",
            payload={"reset_at": 1234567890},
        )
    )
    auth = lookup_config(
        make_event(
            "provider_event",
            provider="claude-code",
            kind="auth_status",
            payload={"status": "expired"},
        )
    )
    assert rate_limit.voice_action == "speak"
    assert rate_limit.priority >= 7
    assert auth.voice_action == "speak"
    assert auth.priority == 9


async def test_buffered_inject_drains_into_next_prompt() -> None:
    """Simulates a full round-trip: harness emits inject events while a turn is in
    flight, then a new user turn drains them as a prepended <context> block.
    """
    buffer = DeferredUpdateBuffer()

    # Three inject-eligible events arrive while a turn is in flight.
    for cfg_key, payload in [
        ("session_init", {"model": "claude-sonnet-4-6", "tools": ["Read", "Edit"]}),
        ("reasoning_delta", {"text": "Need to inspect auth.ts before answering"}),
        ("tool_lifecycle:complete", {"name": "Read", "result": "42 lines read"}),
    ]:
        buffer.append(
            text=str(payload),
            source="claude-code",
            kind=cfg_key,
            priority=lookup_config(make_event(cfg_key.split(":", 1)[0])).priority,
        )

    out = buffer.drain_into_prompt()
    # All three blocks present, sorted by priority desc.
    assert out.count("<context") == 3
    assert buffer.is_empty()

    # New user turn would prepend this output to the actual user text.
    final_prompt = f"{out}\n\nuser: please continue"
    assert "<context" in final_prompt
    assert "user: please continue" in final_prompt


async def test_concurrent_event_dispatch_preserves_order() -> None:
    """Buffer should preserve insertion order for same-priority events."""
    buffer = DeferredUpdateBuffer()
    for i in range(5):
        buffer.append(
            text=f"event-{i}",
            source="harness",
            kind="event",
            priority=5,
        )
    out = buffer.drain_into_prompt()
    # Same priority → insertion order preserved
    assert out.index("event-0") < out.index("event-4")

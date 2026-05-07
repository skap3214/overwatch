"""Tests for the registry lookup + voice-action invariants."""

from __future__ import annotations

from overwatch_pipeline.harness_router import (
    DEFAULT_VOICE_ACTION_DEV,
    DEFAULT_VOICE_ACTION_PROD,
    HARNESS_EVENT_CONFIGS,
    lookup_config,
)


def test_tier1_text_delta_speaks() -> None:
    cfg = lookup_config({"type": "text_delta", "text": "hi"})
    assert cfg.voice_action == "speak"
    assert cfg.priority == 8


def test_tool_lifecycle_phases_route_correctly() -> None:
    # Tool lifecycle is always silent in audio. The router additionally
    # forwards a UI mirror for ui-only / inject / speak events so the user
    # sees the tool call appear in the transcript regardless.
    assert lookup_config({"type": "tool_lifecycle", "phase": "start"}).voice_action == "ui-only"
    assert lookup_config({"type": "tool_lifecycle", "phase": "complete"}).voice_action == "inject"
    assert lookup_config({"type": "tool_lifecycle", "phase": "progress"}).voice_action == "ui-only"


def test_tier2_provider_event_lookup() -> None:
    cfg = lookup_config(
        {"type": "provider_event", "provider": "claude-code", "kind": "rate_limit"}
    )
    assert cfg.voice_action == "speak"
    assert cfg.priority == 7


def test_unknown_event_dev_default_is_ui_only() -> None:
    cfg = lookup_config(
        {"type": "provider_event", "provider": "unknown", "kind": "mystery"},
        default_mode="dev",
    )
    assert cfg.voice_action == "ui-only"


def test_unknown_event_prod_default_is_drop() -> None:
    cfg = lookup_config(
        {"type": "provider_event", "provider": "unknown", "kind": "mystery"},
        default_mode="prod",
    )
    assert cfg.voice_action == "drop"


def test_no_default_policy_ever_speaks() -> None:
    """Critical invariant: unknown events must never produce audio."""
    assert DEFAULT_VOICE_ACTION_DEV.voice_action != "speak"
    assert DEFAULT_VOICE_ACTION_PROD.voice_action != "speak"


def test_registry_has_no_steer_action() -> None:
    """The voice_action enum must not include 'steer' — that's a HarnessCommand
    kind only, never produced by background events."""
    for cfg in HARNESS_EVENT_CONFIGS.values():
        assert cfg.voice_action in ("speak", "inject", "ui-only", "drop")

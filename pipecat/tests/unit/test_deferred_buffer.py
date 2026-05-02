"""Tests for the deferred-update buffer (background-event injection)."""

from __future__ import annotations

import time

from overwatch_pipeline.deferred_update_buffer import DeferredUpdateBuffer


def test_empty_buffer_drains_to_empty_string() -> None:
    buf = DeferredUpdateBuffer()
    assert buf.is_empty()
    assert buf.drain_into_prompt() == ""


def test_drain_clears_buffer() -> None:
    buf = DeferredUpdateBuffer()
    buf.append(text="event 1", source="monitor", kind="alert", priority=5)
    assert len(buf) == 1
    out = buf.drain_into_prompt()
    assert "event 1" in out
    assert buf.is_empty()


def test_priority_orders_blocks() -> None:
    buf = DeferredUpdateBuffer()
    buf.append(text="low", source="x", kind="low", priority=1)
    buf.append(text="high", source="x", kind="high", priority=9)
    out = buf.drain_into_prompt()
    # higher priority must appear first
    assert out.index("high") < out.index("low")


def test_xml_escapes_special_chars() -> None:
    buf = DeferredUpdateBuffer()
    buf.append(text="payload", source='evil"name', kind="kind&danger", priority=5)
    out = buf.drain_into_prompt()
    assert "&quot;" in out
    assert "&amp;" in out


def test_stale_entries_dropped() -> None:
    buf = DeferredUpdateBuffer(max_age_seconds=0.05)
    buf.append(text="old", source="x", kind="alert", priority=5)
    time.sleep(0.06)
    out = buf.drain_into_prompt()
    assert out == ""

"""Tests for InferenceGateState and Pre/PostLLMInferenceGate."""

from __future__ import annotations

import asyncio
import time

import pytest

from overwatch_pipeline.inference_gate import InferenceGateState

pytestmark = pytest.mark.asyncio


def test_can_run_now_initially_true() -> None:
    state = InferenceGateState()
    assert state.can_run_now() is True


def test_blocks_when_user_speaking() -> None:
    state = InferenceGateState()
    state.update_user_speaking(True)
    assert state.can_run_now() is False
    state.update_user_speaking(False)
    # cooldown after bot stop only blocks when bot was speaking; user-stop is immediate
    assert state.can_run_now() is True


def test_blocks_when_bot_speaking_with_cooldown() -> None:
    state = InferenceGateState(cooldown_seconds=0.05)
    state.update_bot_speaking(True)
    assert state.can_run_now() is False
    state.update_bot_speaking(False)
    # Cooldown: should still block immediately
    assert state.can_run_now() is False


def test_cooldown_clears_after_threshold() -> None:
    state = InferenceGateState(cooldown_seconds=0.05)
    state.update_bot_speaking(True)
    state.update_bot_speaking(False)
    time.sleep(0.06)
    assert state.can_run_now() is True


def test_blocks_when_harness_in_flight() -> None:
    state = InferenceGateState()
    state.update_harness_in_flight(True)
    assert state.can_run_now() is False
    state.update_harness_in_flight(False)
    assert state.can_run_now() is True


def test_blocks_when_cancel_pending() -> None:
    state = InferenceGateState()
    state.mark_cancel_pending("turn-1")
    assert state.can_run_now() is False
    state.confirm_cancel("turn-1")
    assert state.can_run_now() is True


async def test_wait_until_runnable_unblocks() -> None:
    state = InferenceGateState(cooldown_seconds=0.0)
    state.update_user_speaking(True)

    async def release_after() -> None:
        await asyncio.sleep(0.05)
        state.update_user_speaking(False)

    asyncio.create_task(release_after())
    await asyncio.wait_for(state.wait_until_runnable(), timeout=0.5)
    assert state.can_run_now()

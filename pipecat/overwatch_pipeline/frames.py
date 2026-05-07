"""Custom pipecat Frame types for Overwatch.

These extend pipecat's frame system to carry harness events, harness commands,
and user text input through the pipeline. The pipeline's processors discriminate
on these types to route to the inference gate, harness bridge, deferred buffer,
and TTS.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pipecat.frames.frames import DataFrame

from .protocol import HarnessCommand, HarnessEvent


@dataclass
class UserTextInputFrame(DataFrame):
    """User-typed text from the mobile InputBar.

    Bypasses VAD/STT and the user_aggregator's mute strategy. Handled by
    HarnessBridgeProcessor identically to a voice transcript: in-flight check,
    then submit_text or submit_with_steer.
    """

    text: str = ""

    def __str__(self) -> str:  # pragma: no cover - debug only
        return f"{self.name}(text={self.text!r})"


@dataclass
class MonitorActionFrame(DataFrame):
    """Mobile UI monitor management action.

    This is not user-turn inference. The bridge translates it directly to a
    manage_monitor HarnessCommand and waits for a correlated result snapshot.
    """

    request_id: str = ""
    action: str = ""
    monitor_id: str | None = None
    run_id: str | None = None
    input: dict | None = None


@dataclass
class HarnessEventFrame(DataFrame):
    """A typed harness event arriving from the daemon via the adapter client.

    Routed by HarnessRouter according to HARNESS_EVENT_CONFIGS.
    """

    event: HarnessEvent = field(default=None)  # type: ignore[assignment]


@dataclass
class HarnessCommandFrame(DataFrame):
    """A command emitted by HarnessBridgeProcessor for the adapter client to send.

    Always one of submit_text, submit_with_steer, cancel.
    """

    command: HarnessCommand = field(default=None)  # type: ignore[assignment]


@dataclass
class CancelPendingFrame(DataFrame):
    """Signals the inference gate that a cancellation is in flight.

    Carries the cancelled correlation_id so the gate can refuse new turns
    until cancel_confirmed (or cancel_failed) lands.
    """

    correlation_id: str = ""

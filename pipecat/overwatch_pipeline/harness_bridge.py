"""HarnessBridgeProcessor — the only processor that emits HarnessCommands.

Receives:
- TranscriptionFrame (from STT, after VAD/smart-turn for voice)
- UserTextInputFrame (from a custom processor decoding mobile typed-input
  RTVI server-messages; bypasses VAD/mute)

For each, consults InferenceGateState. If a turn is in flight, emits
submit_with_steer; otherwise emits submit_text. The DeferredUpdateBuffer is
drained into the prompt before submission.

Inbound, it receives HarnessEvents from the HarnessAdapterClient and passes
them downstream as HarnessEventFrames for the HarnessRouter to dispatch.
"""

from __future__ import annotations

import asyncio
import os
from typing import TYPE_CHECKING

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    StartFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .frames import HarnessEventFrame, UserTextInputFrame
from .protocol import (
    Cancel,
    HarnessEvent,
    SubmitText,
    SubmitWithSteer,
)
from .protocol.generated.harness_command_schema import Payload, Payload1, Payload2

# Concrete variants of HarnessCommand. The HarnessCommand RootModel is only
# useful for receive-side discriminated-union validation; on the send side we
# construct one variant directly.
HarnessCommandVariant = SubmitText | SubmitWithSteer | Cancel

if TYPE_CHECKING:
    from .deferred_update_buffer import DeferredUpdateBuffer
    from .harness_adapter_client import HarnessAdapterClient
    from .inference_gate import InferenceGateState


def _new_correlation_id() -> str:
    return os.urandom(8).hex()


class HarnessBridgeProcessor(FrameProcessor):
    def __init__(
        self,
        *,
        adapter_client: HarnessAdapterClient,
        gate_state: InferenceGateState,
        deferred_buffer: DeferredUpdateBuffer,
        default_target: str,
    ) -> None:
        super().__init__()
        self._client = adapter_client
        self._gate = gate_state
        self._buffer = deferred_buffer
        self._default_target = default_target
        self._active_correlation_id: str | None = None
        self._consumer_task: asyncio.Task[None] | None = None

    async def setup(self, setup) -> None:  # type: ignore[override]
        # CRITICAL: pipecat's FrameProcessor.setup wires _clock, _task_manager,
        # _observer, AND creates the input-task that owns push_frame's queue.
        # Skipping super() means push_frame silently drops every frame.
        await super().setup(setup)

    async def cleanup(self) -> None:
        if self._consumer_task:
            self._consumer_task.cancel()
            try:
                await self._consumer_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await super().cleanup()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        # Defer the adapter-event consumer until StartFrame has propagated.
        # If we start it earlier, push_frame from inside _consume_events fires
        # before pipecat's __started flag flips and is silently dropped.
        if isinstance(frame, StartFrame) and self._consumer_task is None:
            self._consumer_task = asyncio.create_task(self._consume_events())

        # Voice path: STT emitted a final transcript.
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            await self._handle_user_input(frame.text)
            return

        # Typed path: server-message decoded as UserTextInputFrame.
        if isinstance(frame, UserTextInputFrame) and frame.text.strip():
            await self._handle_user_input(frame.text)
            return

        await self.push_frame(frame, direction)

    async def _handle_user_input(self, raw_text: str) -> None:
        """Decide submit_text vs submit_with_steer; drain buffer; dispatch."""
        prefix = self._buffer.drain_into_prompt()
        text = f"{prefix}\n\n{raw_text}" if prefix else raw_text

        new_id = _new_correlation_id()

        command: HarnessCommandVariant
        if self._gate.harness_in_flight and self._active_correlation_id:
            command = SubmitWithSteer(
                kind="submit_with_steer",
                correlation_id=new_id,
                target=self._default_target,
                payload=Payload1(
                    text=text,
                    cancels_correlation_id=self._active_correlation_id,
                ),
            )
            self._gate.mark_cancel_pending(self._active_correlation_id)
            logger.info(
                "bridge.submit_with_steer",
                cancels=self._active_correlation_id,
                new_id=new_id,
            )
        else:
            command = SubmitText(
                kind="submit_text",
                correlation_id=new_id,
                target=self._default_target,
                payload=Payload(text=text),
            )
            logger.info("bridge.submit_text", new_id=new_id)

        self._active_correlation_id = new_id
        self._gate.update_harness_in_flight(True)
        await self._client.submit(command)

    async def submit_cancel(self) -> None:
        """Cancel the active turn without a replacement (e.g. user 'stop')."""
        if not self._active_correlation_id:
            return
        target = self._active_correlation_id
        self._gate.mark_cancel_pending(target)
        cancel = Cancel(
            kind="cancel",
            correlation_id=_new_correlation_id(),
            target=self._default_target,
            payload=Payload2(target_correlation_id=target),
        )
        await self._client.submit(cancel)
        logger.info("bridge.cancel", correlation_id=target)

    async def _consume_events(self) -> None:
        """Iterate inbound events from the adapter client; push as frames."""
        try:
            async for event in self._client.events():
                await self.push_frame(HarnessEventFrame(event=event))
                self._on_event(event)
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            logger.error("bridge.consumer_error", err=str(exc))

    def _on_event(self, event: HarnessEvent) -> None:
        """Track in-flight state and cancellation from inbound events."""
        # event is a discriminated-union RootModel — unwrap with .root.
        root = event.root
        event_type = getattr(root, "type", None)
        correlation_id = getattr(root, "correlation_id", None)

        if event_type == "session_end":
            self._gate.update_harness_in_flight(False)
            if correlation_id == self._active_correlation_id:
                self._active_correlation_id = None
        elif event_type == "cancel_confirmed":
            if correlation_id:
                self._gate.confirm_cancel(correlation_id)

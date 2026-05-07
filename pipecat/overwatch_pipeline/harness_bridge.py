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
from typing import TYPE_CHECKING, Literal

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    StartFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame

from .frames import HarnessEventFrame, MonitorActionFrame, UserTextInputFrame
from .protocol import (
    Cancel,
    HarnessEvent,
    ManageMonitor,
    SubmitText,
    SubmitWithSteer,
)
from .protocol.generated.harness_command_schema import Action, Payload, Payload1, Payload2, Payload3

# Concrete variants of HarnessCommand. The HarnessCommand RootModel is only
# useful for receive-side discriminated-union validation; on the send side we
# construct one variant directly.
HarnessCommandVariant = SubmitText | SubmitWithSteer | Cancel | ManageMonitor
UserInputSource = Literal["typed", "voice"]

if TYPE_CHECKING:
    from .deferred_update_buffer import DeferredUpdateBuffer
    from .harness_adapter_client import HarnessAdapterClient
    from .inference_gate import InferenceGateState
    from .pending_user_input_buffer import PendingUserInputBuffer


def _new_correlation_id() -> str:
    return os.urandom(8).hex()


def _join_user_fragments(previous: str, current: str) -> str:
    previous = previous.strip()
    current = current.strip()
    if not previous:
        return current
    if not current:
        return previous
    if current.startswith(previous):
        return current
    if previous.endswith(current):
        return previous
    return f"{previous}\n{current}"


class HarnessBridgeProcessor(FrameProcessor):
    def __init__(
        self,
        *,
        adapter_client: HarnessAdapterClient,
        gate_state: InferenceGateState,
        deferred_buffer: DeferredUpdateBuffer,
        default_target: str,
        pending_user_input: PendingUserInputBuffer | None = None,
    ) -> None:
        super().__init__()
        self._client = adapter_client
        self._gate = gate_state
        self._buffer = deferred_buffer
        if pending_user_input is None:
            from .pending_user_input_buffer import PendingUserInputBuffer

            pending_user_input = PendingUserInputBuffer()
        self._pending_user_input = pending_user_input
        self._default_target = default_target
        self._active_correlation_id: str | None = None
        self._active_user_text: str | None = None
        self._active_user_source: UserInputSource | None = None
        self._stale_correlation_ids: set[str] = set()
        self._consumer_task: asyncio.Task[None] | None = None
        self._server_message_task: asyncio.Task[None] | None = None
        self._pending_drain_task: asyncio.Task[None] | None = None

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
        if self._server_message_task:
            self._server_message_task.cancel()
            try:
                await self._server_message_task
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
            self._server_message_task = asyncio.create_task(
                self._consume_server_messages()
            )

        # Voice path: STT emitted a final transcript.
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            await self._handle_user_input(frame.text, source="voice")
            return

        # Typed path: server-message decoded as UserTextInputFrame.
        if isinstance(frame, UserTextInputFrame) and frame.text.strip():
            await self._handle_user_input(frame.text, source="typed")
            return

        if isinstance(frame, MonitorActionFrame):
            await self._handle_monitor_action(frame)
            return

        await self.push_frame(frame, direction)

    async def _handle_user_input(
        self, raw_text: str, *, source: UserInputSource = "typed"
    ) -> None:
        """Decide submit_text vs submit_with_steer; drain buffer; dispatch.

        Admission rule: only emit `submit_text` when the gate is fully clear
        (`can_run_now()`). When a turn is still in flight we go through the
        `submit_with_steer` path which both cancels the prior turn and starts
        the new one — that's the *only* way a user-input event can preempt.
        Without the full check, we'd bypass user-speaking, bot-speaking
        cooldown, and cancel-pending checks.
        """
        if self._gate.harness_busy:
            self._hold_user_input(
                raw_text,
                reason=self._gate.harness_busy_reason or "harness_busy",
                source=source,
            )
            return

        new_id = _new_correlation_id()
        admitted_raw_text = raw_text.strip()

        command: HarnessCommandVariant
        if self._gate.harness_in_flight and self._active_correlation_id:
            admitted_raw_text = self._compose_inflight_user_text(
                admitted_raw_text, source=source
            )
            text = self._format_admitted_user_text(admitted_raw_text)
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
            self._stale_correlation_ids.add(self._active_correlation_id)
            logger.info(
                "bridge.submit_with_steer",
                cancels=self._active_correlation_id,
                new_id=new_id,
                source=source,
                text_len=len(admitted_raw_text),
            )
        else:
            # No harness turn is in flight. A finalized user turn is allowed
            # to preempt old assistant audio, so do not gate it on
            # bot_speaking or the post-TTS cooldown. Those are audio playback
            # concerns; waiting here makes interruptions feel like they are
            # queued behind the previous response.
            if not self._gate.can_accept_user_turn_now():
                logger.info(
                    "bridge.deferred",
                    reason="user_turn_gate_busy",
                    user_speaking=self._gate.user_speaking,
                    bot_speaking=self._gate.bot_speaking,
                    harness_busy=self._gate.harness_busy,
                    harness_busy_reason=self._gate.harness_busy_reason,
                    cancel_pending=self._gate.has_cancel_pending,
                    cooldown_remaining=self._gate.cooldown_remaining,
                )
                self._hold_user_input(
                    raw_text, reason="user_turn_gate_busy", source=source
                )
                return
            text = self._format_admitted_user_text(admitted_raw_text)
            command = SubmitText(
                kind="submit_text",
                correlation_id=new_id,
                target=self._default_target,
                payload=Payload(text=text),
            )
            logger.info(
                "bridge.submit_text",
                new_id=new_id,
                source=source,
                text_len=len(admitted_raw_text),
                preempting_bot_audio=self._gate.bot_speaking
                or self._gate.cooldown_remaining > 0,
                cooldown_remaining=self._gate.cooldown_remaining,
            )

        self._active_correlation_id = new_id
        self._active_user_text = admitted_raw_text
        self._active_user_source = source
        self._gate.update_harness_in_flight(True)
        await self._client.submit(command)

    async def _handle_monitor_action(self, frame: MonitorActionFrame) -> None:
        """Forward UI monitor actions without entering the user-turn gate."""
        try:
            action = Action(frame.action)
        except ValueError:
            await self.push_frame(
                RTVIServerMessageFrame(
                    data={
                        "type": "monitor_action_result",
                        "request_id": frame.request_id,
                        "ok": False,
                        "action": frame.action,
                        "error": {
                            "code": "invalid_monitor_action",
                            "message": f"Unsupported monitor action: {frame.action}",
                        },
                    }
                ),
                FrameDirection.DOWNSTREAM,
            )
            return
        command = ManageMonitor(
            kind="manage_monitor",
            correlation_id=_new_correlation_id(),
            target=self._default_target,
            payload=Payload3(
                request_id=frame.request_id,
                action=action,
                monitor_id=frame.monitor_id,
                run_id=frame.run_id,
                input=frame.input,
            ),
        )
        await self._client.submit(command)

    def _format_admitted_user_text(self, raw_text: str) -> str:
        prefix = self._buffer.drain_into_prompt()
        return f"{prefix}\n\n{raw_text}" if prefix else raw_text

    def _compose_inflight_user_text(
        self, raw_text: str, *, source: UserInputSource
    ) -> str:
        if (
            source == "voice"
            and self._active_user_source == "voice"
            and self._active_user_text
        ):
            return _join_user_fragments(self._active_user_text, raw_text)
        return raw_text

    def _hold_user_input(
        self, raw_text: str, *, reason: str, source: UserInputSource
    ) -> None:
        text = raw_text.strip()
        pending = self._pending_user_input.peek()
        if source == "voice" and pending and pending.source == "voice":
            text = _join_user_fragments(pending.text, text)
        self._pending_user_input.hold(text, reason=reason, source=source)
        logger.info("bridge.pending_user_input", reason=reason, source=source)
        self._schedule_pending_drain()

    async def drain_pending_user_input(self) -> bool:
        """Submit the held user turn if the gate is runnable.

        Returns True when a pending turn was admitted.
        """
        if self._pending_user_input.is_empty():
            return False
        await self._gate.wait_until_user_turn_acceptable()
        pending = self._pending_user_input.pop()
        if pending is None:
            return False
        source: UserInputSource = "voice" if pending.source == "voice" else "typed"
        await self._handle_user_input(pending.text, source=source)
        return True

    def _schedule_pending_drain(self) -> None:
        if self._pending_user_input.is_empty():
            return
        if self._pending_drain_task and not self._pending_drain_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._pending_drain_task = loop.create_task(self.drain_pending_user_input())

    async def submit_cancel(self) -> None:
        """Cancel the active turn without a replacement (e.g. user 'stop')."""
        if self._gate.harness_busy:
            logger.info(
                "bridge.cancel_suppressed_harness_busy",
                reason=self._gate.harness_busy_reason,
            )
            return
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
                should_forward = self._on_event(event)
                if should_forward:
                    await self.push_frame(HarnessEventFrame(event=event))
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            logger.error("bridge.consumer_error", err=str(exc))

    async def _consume_server_messages(self) -> None:
        """Forward daemon UI server messages to the mobile RTVI data channel."""
        try:
            async for message in self._client.server_messages():
                await self.push_frame(
                    RTVIServerMessageFrame(
                        data=message.root.model_dump(mode="json", by_alias=True)
                    ),
                    FrameDirection.DOWNSTREAM,
                )
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            logger.error("bridge.server_message_consumer_error", err=str(exc))

    def _on_event(self, event: HarnessEvent) -> bool:
        """Track in-flight state and cancellation from inbound events.

        Correlation-aware: a stale `session_end` (e.g. a late delivery from a
        cancelled turn) MUST NOT clear in-flight if a newer turn is already
        active. Otherwise we'd false-idle while a real turn is running.
        """
        # event is a discriminated-union RootModel — unwrap with .root.
        root = event.root
        event_type = getattr(root, "type", None)
        correlation_id = getattr(root, "correlation_id", None)

        if (
            correlation_id in self._stale_correlation_ids
            and event_type not in {"cancel_confirmed", "session_end", "error"}
        ):
            logger.debug(
                "bridge.drop_stale_event",
                event_type=event_type,
                correlation_id=correlation_id,
            )
            return False

        if event_type == "session_end":
            # Only clear in-flight when the session_end matches the active
            # turn. Late session_ends from cancelled correlations are
            # expected (StaleSuppression on the daemon side will already
            # have suppressed most), so they're harmless to ignore here.
            if correlation_id == self._active_correlation_id:
                self._gate.update_harness_in_flight(False)
                self._active_correlation_id = None
                self._active_user_text = None
                self._active_user_source = None
                self._schedule_pending_drain()
            else:
                logger.debug(
                    "bridge.ignored_stale_session_end",
                    event_correlation=correlation_id,
                    active=self._active_correlation_id,
                )
            if correlation_id in self._stale_correlation_ids:
                self._stale_correlation_ids.discard(correlation_id)
        elif event_type == "cancel_confirmed":
            if correlation_id:
                self._gate.confirm_cancel(correlation_id)
        elif event_type == "error":
            # When the daemon's cancel handshake times out, it surfaces an
            # `error` event with a "cancel_confirmed timeout" message
            # (correlation_id = the cancelled turn). Without explicit
            # handling, that turn would stay in the gate's cancel-pending
            # set forever, jamming all future turns. The auto-expire on
            # InferenceGateState is the safety net; this is the fast path.
            message = getattr(root, "message", "") or ""
            if "cancel_confirmed" in message and correlation_id:
                self._gate.confirm_cancel(correlation_id)
                logger.info(
                    "bridge.cancel_timeout_recovery",
                    correlation_id=correlation_id,
                )
        elif event_type == "agent_busy":
            phase = getattr(root, "phase", None)
            reason = getattr(root, "reason", None) or (
                phase.value if hasattr(phase, "value") else str(phase or "busy")
            )
            self._gate.update_harness_busy(True, reason=reason)
            logger.info("bridge.agent_busy", phase=reason)
        elif event_type == "agent_idle":
            self._gate.update_harness_busy(False)
            logger.info("bridge.agent_idle")
            self._schedule_pending_drain()
        return True

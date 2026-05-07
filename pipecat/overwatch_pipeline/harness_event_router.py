"""HarnessRouterProcessor — turns inbound HarnessEventFrames into outbound
TTS / server-message / inject-buffer / drop actions per the registry.

Turn bracketing
---------------
Cartesia (and any LLM-aware TTS) expects a stream framed as

    LLMFullResponseStartFrame
        LLMTextFrame*
    LLMFullResponseEndFrame

without those start/end brackets it buffers chunks waiting for the end
marker, which manifests as "the previous turn's audio plays when the next
turn begins" in dev. We bracket per harness turn (keyed by correlation_id)
and finalize on assistant_message (terminal Tier-1 event) or session_end.

One-shot speakables — synthesized phrases for tool_lifecycle:start, errors,
or provider events that route to "speak" — are emitted as `TTSSpeakFrame`
because they're independent of any LLM response context.
"""

from __future__ import annotations

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame

from .deferred_update_buffer import DeferredUpdateBuffer
from .frames import HarnessEventFrame
from .harness_router import lookup_config

# Tier-1 events whose text content is part of an LLM response stream and
# must therefore be bracketed by LLMFullResponseStart/End frames.
_STREAMING_TYPES = {"text_delta", "assistant_message"}


class HarnessRouterProcessor(FrameProcessor):
    def __init__(
        self,
        *,
        deferred_buffer: DeferredUpdateBuffer,
        default_mode: str = "dev",
    ) -> None:
        super().__init__()
        self._buffer = deferred_buffer
        self._default_mode = default_mode
        # Turn bracketing state.
        self._active_turn_id: str | None = None
        self._turn_open: bool = False
        # True once we've pushed at least one LLMTextFrame in the current turn.
        # Used so assistant_message (which "coalesce_with text_delta" per
        # registry) doesn't double-emit text when deltas already streamed.
        self._turn_streamed_any_text: bool = False

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if not isinstance(frame, HarnessEventFrame):
            await self.push_frame(frame, direction)
            return

        await self._dispatch(frame)

    async def _dispatch(self, frame: HarnessEventFrame) -> None:
        # The .root of the RootModel is the actual variant.
        # mode="json" ensures Enum fields (like ToolLifecycle.phase) serialize
        # to plain strings so the registry's "tool_lifecycle:start" lookup works.
        root = frame.event.root
        event_dict = root.model_dump(mode="json")
        cfg = lookup_config(event_dict, default_mode=self._default_mode)

        action = cfg.voice_action
        event_type = event_dict.get("type")
        correlation_id = event_dict.get("correlation_id")

        # If a new turn arrives while the previous one is still open (e.g.
        # the harness emitted no terminal marker), close it first so TTS
        # flushes before we start the next response.
        if (
            correlation_id
            and self._turn_open
            and correlation_id != self._active_turn_id
        ):
            await self._close_turn()

        if action == "drop":
            logger.debug(
                "router.drop",
                type=event_type,
                provider=event_dict.get("provider"),
                kind=event_dict.get("kind"),
            )
            return

        if action == "speak":
            text = self._extract_text(event_dict)
            if not text:
                logger.debug("router.speak_no_text", event=event_type)
                # Even text-less speak events still surface to the UI.
                await self._forward_to_ui(event_dict)
                return

            if event_type in _STREAMING_TYPES:
                await self._open_turn_if_needed(correlation_id)
                # assistant_message coalesces with text_delta — only emit its
                # text body if we haven't streamed deltas in this turn already.
                should_emit_text = (
                    event_type == "text_delta"
                    or not self._turn_streamed_any_text
                )
                if should_emit_text:
                    await self.push_frame(LLMTextFrame(text), FrameDirection.DOWNSTREAM)
                    self._turn_streamed_any_text = True
                # assistant_message is the Tier-1 terminal — close the turn.
                if event_type == "assistant_message":
                    await self._close_turn()
                # NOTE: do NOT forward streaming text to the UI via
                # RTVIServerMessageFrame. The RTVI observer already relays
                # LLMTextFrames as `bot-llm-text` server messages, which the
                # mobile client handles via `onBotLlmText`. Forwarding here
                # would double every chunk in the transcript.
            else:
                # One-shot speakable (error, provider event speakable).
                # TTSSpeakFrame queues a complete utterance; no bracketing.
                # These flow as `bot-tts-text` (RTVI), but the mobile client
                # doesn't currently subscribe to that — so we DO forward the
                # event explicitly to keep them visible.
                await self.push_frame(TTSSpeakFrame(text), FrameDirection.DOWNSTREAM)
                await self._forward_to_ui(event_dict)
            return

        if action == "inject":
            text = self._extract_text(event_dict)
            if text:
                self._buffer.append(
                    text=text,
                    source=event_dict.get("provider", "harness"),
                    kind=event_type or "event",
                    priority=cfg.priority,
                )
            # Inject events are background context for the next prompt; they
            # also need to be visible in the UI so the user sees what just
            # happened (e.g. a tool completed).
            await self._forward_to_ui(event_dict)
            return

        # ui-only path: session_end finalizes any still-open LLM turn so TTS
        # flushes the last chunks before we surface the end marker to the UI.
        if event_type == "session_end" and self._turn_open:
            await self._close_turn()
        await self._forward_to_ui(event_dict)

    async def _forward_to_ui(self, event_dict: dict) -> None:
        """Push an RTVI server-message so the mobile client's
        `onServerMessage` callback fires.

        We deliberately use `RTVIServerMessageFrame` (not raw
        `OutputTransportMessageFrame`) because the Pipecat RN client only
        triggers `onServerMessage` for messages wrapped in the
        `{label: "rtvi-ai", type: "server-message", data: ...}` envelope.
        Raw Daily app-messages without that envelope are silently dropped
        by the client SDK — which is why tool calls and streamed text
        weren't appearing in the transcript before this change.
        """
        await self.push_frame(
            RTVIServerMessageFrame(
                data={"type": "harness_event", "event": event_dict},
            ),
            FrameDirection.DOWNSTREAM,
        )

    async def _open_turn_if_needed(self, correlation_id: str | None) -> None:
        if self._turn_open:
            return
        await self.push_frame(
            LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM
        )
        self._active_turn_id = correlation_id
        self._turn_open = True
        self._turn_streamed_any_text = False

    async def _close_turn(self) -> None:
        if not self._turn_open:
            return
        await self.push_frame(
            LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM
        )
        self._turn_open = False
        self._active_turn_id = None
        self._turn_streamed_any_text = False

    @staticmethod
    def _extract_text(event: dict) -> str:
        """Pull a speakable / injectable text representation from the event.

        Resolution order:
        1. Top-level text/message string fields.
        2. tool_lifecycle phases get synthesized phrases.
        3. provider_event payload.message or payload.text.
        4. Top-level result if it's a string.
        """
        for key in ("text", "message"):
            value = event.get(key)
            if isinstance(value, str) and value.strip():
                return value

        if event.get("type") == "tool_lifecycle":
            phase = event.get("phase", "")
            name = event.get("name", "tool")
            if phase == "start":
                return f"Running {name}."
            if phase == "complete":
                return f"{name} completed."
            return ""

        if event.get("type") == "provider_event":
            payload = event.get("payload") or {}
            if isinstance(payload, dict):
                for key in ("message", "text"):
                    value = payload.get(key)
                    if isinstance(value, str) and value.strip():
                        return value

        result = event.get("result")
        if isinstance(result, str) and result.strip():
            return result

        return ""

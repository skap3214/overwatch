"""Trace interruption and audio-frame propagation through the live pipeline."""

from __future__ import annotations

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterruptionFrame,
    OutputAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class InterruptionTrace(FrameProcessor):
    def __init__(self, label: str) -> None:
        super().__init__()
        self._label = label
        self._audio_frame_count = 0
        self._audio_bytes = 0
        self._audio_frames_after_interrupt = 0
        self._interrupted_seen = False

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, InterruptionFrame):
            self._audio_frames_after_interrupt = 0
            self._interrupted_seen = True
            logger.warning(
                "interrupt_trace.{} interruption direction={} frame_id={} sibling_id={}",
                self._label,
                direction.name,
                frame.id,
                frame.broadcast_sibling_id,
            )
        elif isinstance(frame, UserStartedSpeakingFrame):
            logger.warning(
                "interrupt_trace.{} user_started_speaking direction={} frame_id={}",
                self._label,
                direction.name,
                frame.id,
            )
        elif isinstance(
            frame,
            (
                BotStartedSpeakingFrame,
                BotStoppedSpeakingFrame,
                TTSStartedFrame,
                TTSStoppedFrame,
            ),
        ):
            logger.info(
                "interrupt_trace.{} speech_marker marker={} direction={} frame_id={}",
                self._label,
                frame.__class__.__name__,
                direction.name,
                frame.id,
            )
        elif isinstance(frame, OutputAudioRawFrame):
            self._audio_frame_count += 1
            self._audio_bytes += len(frame.audio)
            if self._interrupted_seen and self._audio_frames_after_interrupt < 25:
                self._audio_frames_after_interrupt += 1
                logger.warning(
                    "interrupt_trace.{} audio_after_interrupt seq={} bytes={} frames={} sample_rate={} channels={}",
                    self._label,
                    self._audio_frames_after_interrupt,
                    len(frame.audio),
                    frame.num_frames,
                    frame.sample_rate,
                    frame.num_channels,
                )
            elif self._audio_frame_count % 50 == 0:
                logger.info(
                    "interrupt_trace.{} audio_progress total_frames={} total_bytes={}",
                    self._label,
                    self._audio_frame_count,
                    self._audio_bytes,
                )

        await self.push_frame(frame, direction)

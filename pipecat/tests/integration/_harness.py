"""In-process voice-loop regression harness utilities."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from pipecat.frames.frames import Frame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from overwatch_pipeline.harness_adapter_client import HarnessAdapterClient
from overwatch_pipeline.pipeline_factory import (
    PipelineFactoryResult,
    build_orchestrator_pipeline,
)
from overwatch_pipeline.protocol import HarnessEvent
from overwatch_pipeline.settings import Settings


class FakeAdapterClient(HarnessAdapterClient):
    def __init__(self) -> None:
        self.commands: list[Any] = []
        self._queue: asyncio.Queue[HarnessEvent] = asyncio.Queue()

    async def connect(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def submit(self, command: Any) -> None:
        self.commands.append(command)

    def events(self):
        async def _iter():
            while True:
                yield await self._queue.get()

        return _iter()

    async def push_event(self, event: HarnessEvent) -> None:
        await self._queue.put(event)


class PassthroughProcessor(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


@dataclass
class FrameRecorder:
    frames: list[tuple[str, Frame, FrameDirection]] = field(default_factory=list)

    async def push(self, frame: Frame, direction=FrameDirection.DOWNSTREAM) -> None:
        self.frames.append((type(frame).__name__, frame, direction))

    def names(self) -> list[str]:
        return [name for name, _, _ in self.frames]

    def count(self, name: str) -> int:
        return sum(1 for frame_name, _, _ in self.frames if frame_name == name)


@dataclass
class TestPipelineContext:
    factory: PipelineFactoryResult
    client: FakeAdapterClient
    recorder: FrameRecorder

    @property
    def bridge(self):
        return self.factory.bridge

    @property
    def router(self):
        return self.factory.router

    @property
    def gate(self):
        return self.factory.gate_state

    @property
    def deferred_buffer(self):
        return self.factory.deferred_buffer

    @property
    def pending_user_input(self):
        return self.factory.pending_user_input

    async def run_until(
        self, predicate: Callable[[], bool], timeout: float = 1.0
    ) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while not predicate():
            if asyncio.get_running_loop().time() >= deadline:
                raise AssertionError("timed out waiting for harness predicate")
            await asyncio.sleep(0.01)


def build_test_pipeline(default_mode: str = "dev") -> TestPipelineContext:
    client = FakeAdapterClient()
    settings = Settings(
        deepgram_api_key="test",
        cartesia_api_key="test",
        cooldown_seconds=0.0,
        registry_default_mode=default_mode,
    )
    factory = build_orchestrator_pipeline(
        transport_input=PassthroughProcessor(),
        transport_output=PassthroughProcessor(),
        stt=PassthroughProcessor(),
        tts=PassthroughProcessor(),
        adapter_client=client,
        settings=settings,
        default_target="claude-code",
    )
    recorder = FrameRecorder()
    factory.router.push_frame = recorder.push  # type: ignore[method-assign]
    return TestPipelineContext(factory=factory, client=client, recorder=recorder)

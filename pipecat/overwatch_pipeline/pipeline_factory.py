"""Production-owned pipeline composition factory.

`bot.py` owns real transport/provider construction. This module owns processor
ordering and shared state wiring so tests can exercise the same composition
contract instead of hand-copying a parallel pipeline shape.
"""

from __future__ import annotations

from dataclasses import dataclass

from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.frame_processor import FrameProcessor

from .deferred_update_buffer import DeferredUpdateBuffer
from .harness_adapter_client import HarnessAdapterClient
from .harness_bridge import HarnessBridgeProcessor
from .harness_event_router import HarnessRouterProcessor
from .idle_report import IdleReportProcessor
from .inference_gate import (
    InferenceGateState,
    PostLLMInferenceGate,
    PreLLMInferenceGate,
)
from .interruption_emitter import InterruptionEmitter
from .interruption_trace import InterruptionTrace
from .pending_user_input_buffer import PendingUserInputBuffer
from .say_text_voice_guard import SayTextVoiceGuard
from .settings import Settings
from .typed_input_decoder import TypedInputDecoder


@dataclass
class PipelineFactoryResult:
    pipeline: Pipeline
    processors: list[FrameProcessor]
    gate_state: InferenceGateState
    deferred_buffer: DeferredUpdateBuffer
    pending_user_input: PendingUserInputBuffer
    bridge: HarnessBridgeProcessor
    router: HarnessRouterProcessor


def build_orchestrator_pipeline(
    *,
    transport_input: FrameProcessor,
    transport_output: FrameProcessor,
    stt: FrameProcessor,
    tts: FrameProcessor,
    adapter_client: HarnessAdapterClient,
    settings: Settings,
    default_target: str,
    user_turn_processor: FrameProcessor | None = None,
) -> PipelineFactoryResult:
    gate_state = InferenceGateState(
        cooldown_seconds=settings.cooldown_seconds,
        cancel_confirm_timeout_seconds=settings.cancel_confirm_timeout_seconds,
    )
    deferred_buffer = DeferredUpdateBuffer()
    pending_user_input = PendingUserInputBuffer()

    typed_input_decoder = TypedInputDecoder()
    interruption_emitter = InterruptionEmitter()
    trace_after_input = InterruptionTrace("after_input")
    trace_before_tts = InterruptionTrace("before_tts")
    trace_after_tts = InterruptionTrace("after_tts")
    idle_report = IdleReportProcessor(
        gate_state=gate_state,
        buffer=deferred_buffer,
        threshold_seconds=settings.idle_report_threshold_seconds,
        cooldown_seconds=settings.idle_report_cooldown_seconds,
    )
    pre_gate = PreLLMInferenceGate(state=gate_state)
    bridge = HarnessBridgeProcessor(
        adapter_client=adapter_client,
        gate_state=gate_state,
        deferred_buffer=deferred_buffer,
        default_target=default_target,
        pending_user_input=pending_user_input,
    )
    router = HarnessRouterProcessor(
        deferred_buffer=deferred_buffer,
        default_mode=settings.registry_default_mode,
    )
    post_gate = PostLLMInferenceGate(state=gate_state)
    say_guard = SayTextVoiceGuard()

    processors: list[FrameProcessor] = [
        transport_input,
        typed_input_decoder,
        interruption_emitter,
        trace_after_input,
        stt,
    ]
    if user_turn_processor is not None:
        processors.append(user_turn_processor)
    processors.extend(
        [
            idle_report,
            pre_gate,
            bridge,
            router,
            post_gate,
            say_guard,
            trace_before_tts,
            tts,
            trace_after_tts,
            transport_output,
        ]
    )

    return PipelineFactoryResult(
        pipeline=Pipeline(processors),
        processors=processors,
        gate_state=gate_state,
        deferred_buffer=deferred_buffer,
        pending_user_input=pending_user_input,
        bridge=bridge,
        router=router,
    )

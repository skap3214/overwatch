"""Overwatch orchestrator pipeline — pipecat composition.

This is the entrypoint Pipecat Cloud invokes per session. The shape:

    transport.input
      → DeepgramSTTService (streaming Nova-3)
      → IdleReportProcessor                (parallel)
      → PreLLMInferenceGate
      → user_aggregator (Silero VAD + smart-turn)
      → HarnessBridgeProcessor             ↔ HarnessAdapterClient
      → HarnessRouterProcessor             (registry-driven dispatch)
      → PostLLMInferenceGate
      → SayTextVoiceGuard
      → CartesiaTTSService (streaming Sonic)
      → transport.output

No LLMService in the main flow — Architecture I. The harness on the user's
Mac is the LLM, accessed via HarnessAdapterClient through the relay.

Pipecat Cloud invokes the canonical `bot(runner_args)` entrypoint per session.
Locally, run with `python -m overwatch_pipeline.bot -t daily` (see
pipecat.runner.run for transport flags).
"""

from __future__ import annotations

from loguru import logger

from .deferred_update_buffer import DeferredUpdateBuffer
from .harness_adapter_client import HarnessAdapterClient, RelayClient
from .harness_bridge import HarnessBridgeProcessor
from .harness_event_router import HarnessRouterProcessor
from .idle_report import IdleReportProcessor
from .inference_gate import (
    InferenceGateState,
    PostLLMInferenceGate,
    PreLLMInferenceGate,
)
from .say_text_voice_guard import SayTextVoiceGuard
from .settings import Settings, load
from .voices import resolve_voice_id


async def bot(runner_args) -> None:  # noqa: ANN001
    """Pipecat Cloud / local-runner entrypoint.

    Pipecat Cloud injects `runner_args` (DailyRunnerArguments) per session.
    The body field carries our session-start payload from the relay.
    """
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.runner.types import DailyRunnerArguments
    from pipecat.services.cartesia.tts import CartesiaTTSService
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.transports.daily.transport import DailyParams, DailyTransport

    settings = load()
    _setup_observability(settings)

    if not isinstance(runner_args, DailyRunnerArguments):
        raise RuntimeError(
            f"overwatch-orchestrator requires Daily runner args; got {type(runner_args).__name__}"
        )

    # Body shape from /api/sessions/start: { user_id, pairing_token }.
    body = runner_args.body or {}
    if not isinstance(body, dict):
        body = {}
    user_id = body.get("user_id") or "alpha"
    pairing_token = body.get("pairing_token") or settings.session_token_secret
    target = body.get("default_target") or "claude-code"

    transport = DailyTransport(
        runner_args.room_url,
        runner_args.token,
        "Overwatch",
        params=DailyParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
        ),
    )

    stt = DeepgramSTTService(
        api_key=settings.deepgram_api_key,
        live_options={"model": "nova-3", "interim_results": True},
    )

    tts = CartesiaTTSService(
        api_key=settings.cartesia_api_key,
        voice_id=resolve_voice_id(settings.cartesia_voice_id),
    )

    gate_state = InferenceGateState(
        cooldown_seconds=settings.cooldown_seconds,
        cancel_confirm_timeout_seconds=settings.cancel_confirm_timeout_seconds,
    )
    pre_gate = PreLLMInferenceGate(state=gate_state)
    post_gate = PostLLMInferenceGate(state=gate_state)

    buffer = DeferredUpdateBuffer()

    adapter_client: HarnessAdapterClient = RelayClient(
        relay_url=settings.relay_url,
        user_id=user_id,
        pairing_token=pairing_token,
        session_token=settings.session_token_secret,
    )
    await adapter_client.connect()  # type: ignore[union-attr]

    bridge = HarnessBridgeProcessor(
        adapter_client=adapter_client,
        gate_state=gate_state,
        deferred_buffer=buffer,
        default_target=target,
    )
    router = HarnessRouterProcessor(
        deferred_buffer=buffer,
        default_mode=settings.registry_default_mode,
    )

    idle_report = IdleReportProcessor(
        gate_state=gate_state,
        buffer=buffer,
        threshold_seconds=settings.idle_report_threshold_seconds,
        cooldown_seconds=settings.idle_report_cooldown_seconds,
    )

    say_guard = SayTextVoiceGuard()

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            idle_report,
            pre_gate,
            bridge,
            router,
            post_gate,
            say_guard,
            tts,
            transport.output(),
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    try:
        await PipelineRunner().run(task)
    finally:
        await adapter_client.close()


def _setup_observability(settings: Settings) -> None:
    """Wire OTel + Sentry if endpoints are configured. No-op otherwise."""
    if settings.sentry_dsn:
        try:
            import sentry_sdk

            sentry_sdk.init(
                dsn=settings.sentry_dsn,
                environment=settings.environment,
                traces_sample_rate=0.1,
            )
            logger.info("observability.sentry_enabled")
        except Exception as exc:  # noqa: BLE001
            logger.warning("observability.sentry_init_failed err={}", str(exc))

    if settings.otel_endpoint:
        try:
            from opentelemetry import trace
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                OTLPSpanExporter,
            )
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import BatchSpanProcessor

            resource = Resource.create({"service.name": "overwatch-orchestrator"})
            provider = TracerProvider(resource=resource)
            provider.add_span_processor(
                BatchSpanProcessor(
                    OTLPSpanExporter(
                        endpoint=settings.otel_endpoint,
                        headers=settings.otel_headers,
                    )
                )
            )
            trace.set_tracer_provider(provider)
            logger.info("observability.otel_enabled")
        except Exception as exc:  # noqa: BLE001
            logger.warning("observability.otel_init_failed err={}", str(exc))


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()

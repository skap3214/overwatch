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

from .auth import create_token_validator
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
from .typed_input_decoder import TypedInputDecoder
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
    from pipecat.services.deepgram.stt import DeepgramSTTService, DeepgramSTTSettings
    from pipecat.transports.daily.transport import DailyParams, DailyTransport

    settings = load()
    _setup_observability(settings)

    if not isinstance(runner_args, DailyRunnerArguments) and not (
        hasattr(runner_args, "room_url") and hasattr(runner_args, "token")
    ):
        raise RuntimeError(
            f"overwatch-orchestrator requires Daily-style runner args; got "
            f"{type(runner_args).__name__}"
        )

    # Body shape from relay's /api/sessions/start:
    #   { user_id, pairing_token, session_token, default_target? }
    # - pairing_token authenticates the bot's WS to /api/users/<id>/ws/orchestrator
    # - session_token is the per-session HMAC the daemon's TokenValidator verifies
    #   on every harness_command envelope; the phone signed it with the same
    #   shared pairing_token, so the bot just forwards it without re-deriving.
    body = runner_args.body or {}
    if not isinstance(body, dict):
        body = {}
    user_id = body.get("user_id") or "alpha"
    pairing_token = body.get("pairing_token") or ""
    session_token = body.get("session_token") or ""
    target = body.get("default_target") or "claude-code"

    if not user_id or not pairing_token or not session_token:
        raise RuntimeError(
            "overwatch-orchestrator missing identity in runner_args.body — "
            "expected user_id, pairing_token, session_token (got "
            f"keys: {sorted(body.keys())})"
        )

    # Verify the phone-derived session_token at the orchestrator boundary.
    # The daemon also verifies on every command — this catches expired or
    # tampered tokens up-front so the user sees a clear failure instead of
    # a silent dead Daily room.
    token_validator = create_token_validator(pairing_token)
    claims = token_validator.verify(session_token)
    if claims is None:
        raise RuntimeError(
            "overwatch-orchestrator rejected session_token — "
            "expired or signed with a different pairing secret"
        )
    logger.info(
        "bot.session_token_verified",
        session_id=claims.session_id,
        expires_at=claims.expires_at,
    )

    transport = DailyTransport(
        runner_args.room_url,
        runner_args.token,
        "Overwatch",
        params=DailyParams(  # type: ignore[call-arg]
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
        ),
    )

    stt = DeepgramSTTService(
        api_key=settings.deepgram_api_key,
        settings=DeepgramSTTSettings(
            model="nova-3",
            interim_results=True,
        ),
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

    async def _on_harness_state(payload: dict) -> None:
        # Daemon's snapshot is the source of truth for `in_flight` at connect
        # time — it knows about turns that may have started before the
        # orchestrator booted (e.g. mid-flight reconnects).
        in_flight = payload.get("in_flight")
        if isinstance(in_flight, bool):
            gate_state.update_harness_in_flight(in_flight)
            logger.info("bot.harness_state_synced", in_flight=in_flight)

    adapter_client: HarnessAdapterClient = RelayClient(
        relay_url=settings.relay_url,
        user_id=user_id,
        pairing_token=pairing_token,
        session_token=session_token,
        on_harness_state=_on_harness_state,
    )
    await adapter_client.connect()

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

    typed_input_decoder = TypedInputDecoder()

    pipeline = Pipeline(
        [
            transport.input(),
            # Decode Daily app-messages (typed user input from mobile InputBar)
            # into UserTextInputFrames before VAD/STT see anything.
            typed_input_decoder,
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

    # Pipecat 1.1.0 dropped the allow_interruptions kwarg — interruption is
    # always-on once a VAD analyzer is wired into the transport (see DailyParams
    # above). Only the metric flags survive on PipelineParams.
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
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

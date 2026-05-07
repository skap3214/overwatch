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
      → configured streaming TTS provider (Cartesia or xAI)
      → transport.output

No LLMService in the main flow — Architecture I. The harness on the user's
Mac is the LLM, accessed via HarnessAdapterClient through the relay.

Pipecat Cloud invokes the canonical `bot(runner_args)` entrypoint per session.
Locally, run with `python -m overwatch_pipeline.bot -t daily` (see
pipecat.runner.run for transport flags).
"""

from __future__ import annotations

from loguru import logger

from .harness_adapter_client import HarnessAdapterClient, RelayClient
from .pipeline_factory import build_orchestrator_pipeline
from .settings import Settings, load
from .tts_provider import create_tts_service


async def bot(runner_args) -> None:  # noqa: ANN001
    """Pipecat Cloud / local-runner entrypoint.

    Pipecat Cloud injects `runner_args` (DailyRunnerArguments) per session.
    The body field carries our session-start payload from the relay.
    """
    from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import (
        LocalSmartTurnAnalyzerV3,
    )
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.runner.types import DailyRunnerArguments
    from pipecat.services.deepgram.stt import DeepgramSTTService, DeepgramSTTSettings
    from pipecat.transports.daily.transport import DailyParams, DailyTransport
    from pipecat.turns.user_start.vad_user_turn_start_strategy import (
        VADUserTurnStartStrategy,
    )
    from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import (
        TurnAnalyzerUserTurnStopStrategy,
    )
    from pipecat.turns.user_turn_processor import UserTurnProcessor
    from pipecat.turns.user_turn_strategies import UserTurnStrategies

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
    #   { user_id, session_token, orchestrator_token, default_target? }
    #
    # - session_token: per-session HMAC. The relay verified it before calling
    #   us, and the daemon's TokenValidator verifies it again per-command.
    #   The orchestrator just forwards it on every harness_command envelope.
    # - orchestrator_token: short-lived auth token for the bot's WebSocket
    #   to /api/users/<id>/ws/orchestrator. Scoped to user_id + expires_at
    #   and signed by the relay using the long-term pairing_token. The
    #   pairing_token itself is INTENTIONALLY NOT in this body — we don't
    #   want the long-term Mac secret to traverse Pipecat Cloud.
    body = runner_args.body or {}
    if not isinstance(body, dict):
        body = {}
    user_id = body.get("user_id") or "alpha"
    session_token = body.get("session_token") or ""
    orchestrator_token = body.get("orchestrator_token") or ""
    tts_provider = body.get("tts_provider")
    target = body.get("default_target") or "claude-code"

    if not user_id or not session_token or not orchestrator_token:
        raise RuntimeError(
            "overwatch-orchestrator missing identity in runner_args.body — "
            "expected user_id, session_token, orchestrator_token (got "
            f"keys: {sorted(body.keys())})"
        )

    vad_analyzer = SileroVADAnalyzer()
    transport = DailyTransport(
        runner_args.room_url,
        runner_args.token,
        "Overwatch",
        params=DailyParams(  # type: ignore[call-arg]
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_out_10ms_chunks=1,
            vad_analyzer=vad_analyzer,
        ),
    )
    logger.warning(
        "bot.daily_audio_params audio_out_10ms_chunks=1 audio_out_enabled=True"
    )

    # Keyterm prompting biases Nova-3 toward project / tool / agent names
    # that mainstream models routinely garble (tmux, Hermes, Codex, etc).
    # See settings.DEFAULT_STT_KEYTERMS; override via STT_KEYTERMS env.
    stt_settings_kwargs: dict = {
        "model": "nova-3",
        "interim_results": True,
        "endpointing": settings.stt_endpointing_ms,
        "utterance_end_ms": settings.stt_utterance_end_ms,
    }
    if settings.stt_keyterms:
        stt_settings_kwargs["keyterm"] = list(settings.stt_keyterms)
    stt = DeepgramSTTService(
        api_key=settings.deepgram_api_key,
        settings=DeepgramSTTSettings(**stt_settings_kwargs),
    )

    tts = create_tts_service(
        settings,
        requested_provider=tts_provider if isinstance(tts_provider, str) else None,
    )

    user_turn_processor = UserTurnProcessor(
        user_turn_strategies=UserTurnStrategies(
            start=[VADUserTurnStartStrategy()],
            stop=[
                TurnAnalyzerUserTurnStopStrategy(
                    turn_analyzer=LocalSmartTurnAnalyzerV3()
                )
            ],
        )
    )

    gate_state_ref = {"gate": None}
    initial_harness_state: dict[str, bool] = {}

    async def _on_harness_state(payload: dict) -> None:
        # Daemon's snapshot is the source of truth for `in_flight` at connect
        # time — it knows about turns that may have started before the
        # orchestrator booted (e.g. mid-flight reconnects).
        in_flight = payload.get("in_flight")
        if isinstance(in_flight, bool):
            gate = gate_state_ref["gate"]
            if gate is None:
                initial_harness_state["in_flight"] = in_flight
                return
            gate.update_harness_in_flight(in_flight)
            logger.info("bot.harness_state_synced", in_flight=in_flight)

    adapter_client: HarnessAdapterClient = RelayClient(
        relay_url=settings.relay_url,
        user_id=user_id,
        ws_auth_token=orchestrator_token,
        session_token=session_token,
        on_harness_state=_on_harness_state,
    )
    await adapter_client.connect()

    factory = build_orchestrator_pipeline(
        transport_input=transport.input(),
        transport_output=transport.output(),
        stt=stt,
        tts=tts,
        adapter_client=adapter_client,
        settings=settings,
        default_target=target,
        user_turn_processor=user_turn_processor,
    )
    gate_state_ref["gate"] = factory.gate_state
    if "in_flight" in initial_harness_state:
        factory.gate_state.update_harness_in_flight(initial_harness_state["in_flight"])
        logger.info(
            "bot.harness_state_synced",
            in_flight=initial_harness_state["in_flight"],
        )

    # Pipecat 1.1.0 dropped the allow_interruptions kwarg — interruption is
    # always-on once a VAD analyzer is wired into the transport (see DailyParams
    # above). Only the metric flags survive on PipelineParams.
    task = PipelineTask(
        factory.pipeline,
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

"""Registry-driven event routing for harness events.

Implements the load-bearing piece of the plan (§4.4.3): the
HARNESS_EVENT_CONFIGS dict maps every Tier-1 canonical event type and every
Tier-2 "<provider>/<kind>" string to a HarnessEventConfig that decides what
the orchestrator should *do* with the event.

Voice actions (Architecture I):
- speak     → text content goes to TTS, gated by InferenceGateState
- inject    → payload buffered for prepend on next user turn
- ui-only   → forwarded to mobile UI via RTVI server-message
- drop      → no-op with a debug log

Invariants enforced at dispatch:
1. Only user input ever produces submit_with_steer or cancel.
2. Unknown events never produce audio. Default policy is ui-only (dev) or drop
   (prod). Promoting to speak requires an explicit registry entry.
3. Every event is logged.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from loguru import logger

VoiceAction = Literal["speak", "inject", "ui-only", "drop"]


@dataclass(frozen=True)
class HarnessEventConfig:
    voice_action: VoiceAction
    priority: int = 5
    coalesce_with: str | None = None
    debounce_ms: int | None = None
    provider: str = "*"


HARNESS_EVENT_CONFIGS: dict[str, HarnessEventConfig] = {
    # ─── Tier 1 — cross-provider canonical ──────────────────────────────────
    "text_delta": HarnessEventConfig("speak", priority=8),
    "assistant_message": HarnessEventConfig(
        "speak", priority=8, coalesce_with="text_delta"
    ),
    "reasoning_delta": HarnessEventConfig("inject", priority=3),
    "tool_lifecycle:start": HarnessEventConfig("speak", priority=6),
    "tool_lifecycle:progress": HarnessEventConfig("ui-only", priority=4),
    "tool_lifecycle:complete": HarnessEventConfig("inject", priority=4),
    "session_init": HarnessEventConfig("inject", priority=1),
    "session_end": HarnessEventConfig("ui-only", priority=2),
    "error": HarnessEventConfig("speak", priority=9),
    "cancel_confirmed": HarnessEventConfig("ui-only", priority=2),
    # ─── Tier 2 — Claude Code provider-specific ─────────────────────────────
    "claude-code/compact_boundary": HarnessEventConfig(
        "ui-only", priority=2, provider="claude-code"
    ),
    "claude-code/files_persisted": HarnessEventConfig(
        "inject", priority=2, debounce_ms=500, provider="claude-code"
    ),
    "claude-code/rate_limit": HarnessEventConfig(
        "speak", priority=7, provider="claude-code"
    ),
    "claude-code/auth_status": HarnessEventConfig(
        "speak", priority=9, provider="claude-code"
    ),
    "claude-code/task_progress": HarnessEventConfig(
        "ui-only", priority=3, provider="claude-code"
    ),
    "claude-code/hook_response": HarnessEventConfig(
        "drop", priority=1, provider="claude-code"
    ),
    "claude-code/prompt_suggestion": HarnessEventConfig(
        "ui-only", priority=2, provider="claude-code"
    ),
    "claude-code/plugin_install": HarnessEventConfig(
        "ui-only", priority=3, provider="claude-code"
    ),
    "claude-code/tool_use_summary": HarnessEventConfig(
        "inject", priority=3, provider="claude-code"
    ),
    # ─── Tier 2 — Hermes provider-specific ──────────────────────────────────
    "hermes/run_completed": HarnessEventConfig(
        "ui-only", priority=2, provider="hermes"
    ),
    # ─── Tier 2 — Pi provider-specific ──────────────────────────────────────
    "pi/session_stats": HarnessEventConfig("ui-only", priority=1, provider="pi"),
    # ─── Tier 2 — Overwatch-internal events ─────────────────────────────────
    "overwatch/monitor_fired": HarnessEventConfig(
        "inject", priority=5, provider="overwatch"
    ),
    "overwatch/notification": HarnessEventConfig(
        "speak", priority=6, provider="overwatch"
    ),
    "overwatch/scheduled_task_done": HarnessEventConfig(
        "inject", priority=4, provider="overwatch"
    ),
}

# ─── Default policy for events with no registry entry ──────────────────────
DEFAULT_VOICE_ACTION_DEV = HarnessEventConfig("ui-only", priority=1)
DEFAULT_VOICE_ACTION_PROD = HarnessEventConfig("drop", priority=1)


def lookup_config(event: dict, default_mode: str = "dev") -> HarnessEventConfig:
    """Resolve a HarnessEventConfig for the given event dict.

    Priority:
    1. For Tier 1: lookup by `type` (with phase suffix for tool_lifecycle).
    2. For Tier 2: lookup by `<provider>/<kind>`.
    3. Otherwise: default policy by mode.

    Invariant: even default-policy events never return "speak".
    """
    event_type = event.get("type")
    if event_type == "tool_lifecycle":
        phase = event.get("phase", "start")
        key = f"tool_lifecycle:{phase}"
        if key in HARNESS_EVENT_CONFIGS:
            return HARNESS_EVENT_CONFIGS[key]
    elif event_type == "provider_event":
        provider = event.get("provider", "")
        kind = event.get("kind", "")
        key = f"{provider}/{kind}"
        if key in HARNESS_EVENT_CONFIGS:
            return HARNESS_EVENT_CONFIGS[key]
        logger.bind(provider=provider, kind=kind).info(
            "router.unknown_event", payload=event.get("payload")
        )
    elif isinstance(event_type, str) and event_type in HARNESS_EVENT_CONFIGS:
        return HARNESS_EVENT_CONFIGS[event_type]

    # Default policy never returns speak — the invariant we care about.
    if default_mode == "prod":
        return DEFAULT_VOICE_ACTION_PROD
    return DEFAULT_VOICE_ACTION_DEV

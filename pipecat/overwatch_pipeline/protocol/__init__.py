"""Protocol types — facade over the codegen output.

Edit the JSON Schema in /protocol/schema/ and run `npm run protocol:gen` to
update. Never edit files in `generated/` directly.
"""

from .generated.envelope_schema import Envelope
from .generated.harness_command_schema import (
    Cancel,
    HarnessCommand,
    ManageMonitor,
    SubmitText,
    SubmitWithSteer,
)
from .generated.harness_event_schema import (
    AgentBusy,
    AgentIdle,
    AssistantMessage,
    CancelConfirmed,
    ErrorEvent,
    HarnessEvent,
    Phase,
    ProviderEvent,
    ReasoningDelta,
    SessionEnd,
    SessionInit,
    Subtype,
    TextDelta,
    ToolLifecycle,
)
from .generated.server_message_schema import (
    ActiveSkill,
    AgentProviderInfo,
    ErrorResponse,
    HarnessCapabilities,
    HarnessEventForUI,
    HarnessSnapshot,
    HarnessStateSnapshot,
    InterruptIntent,
    MonitorActionMetadata,
    MonitorActionResult,
    MonitorSnapshot,
    Notification,
    ScheduledMonitor,
    ServerMessage,
    SkillsSnapshot,
    UserText,
)

PROTOCOL_VERSION = "1.0"

__all__ = [
    "PROTOCOL_VERSION",
    # Envelope
    "Envelope",
    # HarnessCommand union + variants
    "HarnessCommand",
    "SubmitText",
    "SubmitWithSteer",
    "Cancel",
    "ManageMonitor",
    # HarnessEvent union + variants
    "HarnessEvent",
    "SessionInit",
    "TextDelta",
    "ReasoningDelta",
    "AssistantMessage",
    "ToolLifecycle",
    "Phase",
    "SessionEnd",
    "Subtype",
    "ErrorEvent",
    "CancelConfirmed",
    "AgentBusy",
    "AgentIdle",
    "ProviderEvent",
    # ServerMessage union + variants
    "ServerMessage",
    "UserText",
    "HarnessEventForUI",
    "HarnessStateSnapshot",
    "HarnessSnapshot",
    "HarnessCapabilities",
    "AgentProviderInfo",
    "MonitorSnapshot",
    "ScheduledMonitor",
    "MonitorActionMetadata",
    "SkillsSnapshot",
    "ActiveSkill",
    "MonitorActionResult",
    "InterruptIntent",
    "Notification",
    "ErrorResponse",
]

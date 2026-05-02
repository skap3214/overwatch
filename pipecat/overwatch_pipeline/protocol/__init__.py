"""Protocol types — facade over the codegen output.

Edit the JSON Schema in /protocol/schema/ and run `npm run protocol:gen` to
update. Never edit files in `generated/` directly.
"""

from .generated.envelope_schema import Envelope
from .generated.harness_command_schema import (
    Cancel,
    HarnessCommand,
    SubmitText,
    SubmitWithSteer,
)
from .generated.harness_event_schema import (
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
    ErrorResponse,
    HarnessEventForUI,
    HarnessStateSnapshot,
    InterruptIntent,
    Notification,
    ServerMessage,
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
    "ProviderEvent",
    # ServerMessage union + variants
    "ServerMessage",
    "UserText",
    "HarnessEventForUI",
    "HarnessStateSnapshot",
    "InterruptIntent",
    "Notification",
    "ErrorResponse",
]

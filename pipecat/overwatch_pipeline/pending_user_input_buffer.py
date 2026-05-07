"""Pending user input buffer.

Held user turns must stay user turns; they are not harness/background context
and should not be serialized into ``<context>`` XML blocks.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from threading import Lock


@dataclass(frozen=True)
class PendingUserInput:
    text: str
    reason: str
    timestamp: float
    source: str = "user"


class PendingUserInputBuffer:
    """Last-write-wins user-turn buffer."""

    def __init__(self) -> None:
        self._entry: PendingUserInput | None = None
        self._lock = Lock()

    def hold(self, text: str, *, reason: str, source: str = "user") -> None:
        stripped = text.strip()
        if not stripped:
            return
        with self._lock:
            self._entry = PendingUserInput(
                text=stripped,
                reason=reason,
                timestamp=time.monotonic(),
                source=source,
            )

    def pop(self) -> PendingUserInput | None:
        with self._lock:
            entry = self._entry
            self._entry = None
            return entry

    def peek(self) -> PendingUserInput | None:
        with self._lock:
            return self._entry

    def is_empty(self) -> bool:
        return self.peek() is None

    def __len__(self) -> int:
        return 0 if self.peek() is None else 1

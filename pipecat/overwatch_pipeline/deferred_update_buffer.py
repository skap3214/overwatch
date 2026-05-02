"""DeferredUpdateBuffer — buffers `inject` events for prepend on next user turn.

In Architecture I (no voice LLM), the harness is the sole LLM. Events with
voice_action='inject' get buffered here and prepended to the next user-initiated
turn as <context kind="..." source="..." priority="...">...</context> blocks.

This is the universally-supported flavor of injection: works on any provider
because it's just string concatenation in the orchestrator, not a harness-side
API call.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from threading import Lock


@dataclass
class BufferedInjection:
    text: str
    source: str
    kind: str
    priority: int
    timestamp: float


@dataclass
class DeferredUpdateBuffer:
    max_age_seconds: float = 600.0  # 10 minutes — injections older than this are dropped
    _entries: list[BufferedInjection] = field(default_factory=list)
    _lock: Lock = field(default_factory=Lock)

    def append(
        self,
        *,
        text: str,
        source: str,
        kind: str,
        priority: int = 5,
    ) -> None:
        with self._lock:
            self._entries.append(
                BufferedInjection(
                    text=text,
                    source=source,
                    kind=kind,
                    priority=priority,
                    timestamp=time.monotonic(),
                )
            )

    def drain_into_prompt(self) -> str:
        """Format all pending entries as XML context blocks and clear the buffer.

        Returns "" if the buffer is empty. Stale entries (older than max_age)
        are silently dropped.
        """
        with self._lock:
            now = time.monotonic()
            fresh = [
                e
                for e in self._entries
                if now - e.timestamp <= self.max_age_seconds
            ]
            self._entries.clear()

        if not fresh:
            return ""

        # Sort by priority descending so the most important entries land first.
        fresh.sort(key=lambda e: e.priority, reverse=True)

        blocks = []
        for entry in fresh:
            blocks.append(
                f'<context kind="{_escape(entry.kind)}" '
                f'source="{_escape(entry.source)}" '
                f'priority="{entry.priority}">'
                f"{entry.text}"
                "</context>"
            )
        return "\n".join(blocks)

    def is_empty(self) -> bool:
        with self._lock:
            return not self._entries

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


def _escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )

"""HarnessAdapterClient — the orchestrator's interface to the daemon.

The orchestrator never imports a specific transport. It uses the Protocol
defined here, and at startup the bot.py composition picks an implementation:

- RelayClient: routes through the CF Workers relay over WebSocket. Production.
- LocalUDSClient: routes via Unix domain socket on localhost. Y2 self-host.

The interface is identical so swapping is a config flag, not a refactor.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import AsyncIterator, Protocol

from loguru import logger
import websockets

from .protocol import (
    HarnessCommand,
    HarnessEvent,
    Envelope,
    PROTOCOL_VERSION,
)


class HarnessAdapterClient(Protocol):
    async def submit(self, command: HarnessCommand) -> None: ...

    def events(self) -> AsyncIterator[HarnessEvent]: ...

    async def close(self) -> None: ...


class RelayClient:
    """Routes through CF Workers relay to user's Mac daemon.

    Carries per-user + per-session tokens on every command. Maintains a single
    WebSocket connection; reconnects with backoff on disconnect.
    """

    def __init__(
        self,
        relay_url: str,
        session_token: str,
        reconnect_delay: float = 2.0,
    ) -> None:
        self._url = relay_url
        self._session_token = session_token
        self._reconnect_delay = reconnect_delay
        self._socket: websockets.ClientConnection | None = None
        self._send_lock = asyncio.Lock()
        self._event_queue: asyncio.Queue[HarnessEvent] = asyncio.Queue()
        self._reader_task: asyncio.Task[None] | None = None
        self._stopped = False

    async def connect(self) -> None:
        while not self._stopped:
            try:
                self._socket = await websockets.connect(self._url)
                logger.info("relay-client.connected", url=self._url)
                self._reader_task = asyncio.create_task(self._reader_loop())
                return
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "relay-client.connect_failed",
                    url=self._url,
                    err=str(exc),
                )
                await asyncio.sleep(self._reconnect_delay)

    async def submit(self, command: HarnessCommand) -> None:
        envelope = self._envelope_command(command)
        async with self._send_lock:
            if self._socket is None:
                await self.connect()
            assert self._socket is not None
            await self._socket.send(envelope.model_dump_json(by_alias=True))

    async def _reader_loop(self) -> None:
        socket = self._socket
        if socket is None:
            return
        try:
            async for raw in socket:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if parsed.get("kind") != "harness_event":
                    continue
                payload = parsed.get("payload")
                if not isinstance(payload, dict):
                    continue
                try:
                    # Validate via discriminated-union root model.
                    event = HarnessEvent.model_validate(payload)
                    await self._event_queue.put(event)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("relay-client.invalid_event", err=str(exc))
        except websockets.ConnectionClosed:
            logger.info("relay-client.disconnected")
            self._socket = None
            if not self._stopped:
                await self.connect()

    def events(self) -> AsyncIterator[HarnessEvent]:
        async def _iter() -> AsyncIterator[HarnessEvent]:
            while not self._stopped:
                event = await self._event_queue.get()
                yield event

        return _iter()

    async def close(self) -> None:
        self._stopped = True
        if self._reader_task:
            self._reader_task.cancel()
        if self._socket:
            await self._socket.close()
            self._socket = None

    def _envelope_command(self, command: HarnessCommand) -> Envelope:
        return Envelope(
            protocol_version=PROTOCOL_VERSION,
            kind="harness_command",
            id=os.urandom(8).hex(),
            timestamp=_now_iso(),
            session_token=self._session_token,
            payload=command.model_dump(by_alias=True),
        )


class LocalUDSClient:
    """Routes via Unix domain socket on localhost. Used in Y2 self-host mode.

    Stub for now — implementation lives behind a config flag and is exercised
    only by `HARNESS_ADAPTER_CLIENT=local-uds`. Same Protocol surface as
    RelayClient so swapping is config-only.
    """

    def __init__(self, socket_path: str) -> None:
        self._socket_path = socket_path

    async def submit(self, command: HarnessCommand) -> None:  # pragma: no cover
        raise NotImplementedError("LocalUDSClient is a Y2 stub")

    def events(self) -> AsyncIterator[HarnessEvent]:  # pragma: no cover
        async def _iter() -> AsyncIterator[HarnessEvent]:
            if False:  # pragma: no cover
                yield  # type: ignore[unreachable]

        return _iter()

    async def close(self) -> None:  # pragma: no cover
        return None


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()

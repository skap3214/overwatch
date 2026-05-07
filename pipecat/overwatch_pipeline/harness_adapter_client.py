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
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime
from typing import Protocol

import websockets
from loguru import logger

from .protocol import (
    PROTOCOL_VERSION,
    Cancel,
    Envelope,
    HarnessEvent,
    ManageMonitor,
    ServerMessage,
    SubmitText,
    SubmitWithSteer,
)
from .protocol.generated.envelope_schema import Kind

HarnessCommandVariant = SubmitText | SubmitWithSteer | Cancel | ManageMonitor
HarnessStateCallback = Callable[[dict], Awaitable[None]]


def _major(version: str) -> str:
    """Return the MAJOR component of a `MAJOR.MINOR` protocol version."""
    return version.split(".", 1)[0] if "." in version else version


class HarnessAdapterClient(Protocol):
    async def connect(self) -> None: ...

    async def submit(self, command: HarnessCommandVariant) -> None: ...

    def events(self) -> AsyncIterator[HarnessEvent]: ...

    def server_messages(self) -> AsyncIterator[ServerMessage]: ...

    async def close(self) -> None: ...


class RelayClient:
    """Routes through the CF Workers relay's UserChannel to the user's Mac daemon.

    Connects to `wss://<relay>/api/users/<user_id>/ws/orchestrator?token=<pairing>`.
    The daemon connects to the matching `ws/host` endpoint. The UserChannel
    durable object routes JSON envelopes between the two roles.

    Maintains a single connection with backoff reconnect.
    """

    def __init__(
        self,
        *,
        relay_url: str,
        user_id: str,
        ws_auth_token: str,
        session_token: str,
        reconnect_delay: float = 2.0,
        on_harness_state: HarnessStateCallback | None = None,
    ) -> None:
        # ws_auth_token is the relay-minted short-lived orchestrator_token
        # used to authenticate this WebSocket upgrade. It is NOT the
        # long-term pairing_token — see relay/src/index.ts and
        # docs/architecture/009-auth-pairing-and-tokens.md.
        # Convert https:// to wss:// (and http:// to ws://) so the relay's
        # CF Worker can complete the WebSocket upgrade.
        ws_base = relay_url.replace("https://", "wss://").replace("http://", "ws://")
        self._url = (
            f"{ws_base.rstrip('/')}/api/users/{user_id}/ws/orchestrator"
            f"?token={ws_auth_token}"
        )
        self._user_id = user_id
        self._session_token = session_token
        self._reconnect_delay = reconnect_delay
        self._on_harness_state = on_harness_state
        self._socket: websockets.ClientConnection | None = None
        self._send_lock = asyncio.Lock()
        self._event_queue: asyncio.Queue[HarnessEvent] = asyncio.Queue()
        self._server_message_queue: asyncio.Queue[ServerMessage] = asyncio.Queue()
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

    async def submit(self, command: HarnessCommandVariant) -> None:
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

                # Protocol-version handshake: refuse mismatched majors. We log
                # and drop instead of disconnecting so a one-off bad message
                # doesn't tear down a healthy connection.
                wire_version = parsed.get("protocol_version")
                if isinstance(wire_version, str) and _major(wire_version) != _major(
                    PROTOCOL_VERSION
                ):
                    logger.warning(
                        "relay-client.protocol_version_mismatch",
                        wire_version=wire_version,
                        local_version=PROTOCOL_VERSION,
                    )
                    continue

                kind = parsed.get("kind")
                payload = parsed.get("payload")
                if not isinstance(payload, dict):
                    continue

                if kind == "harness_event":
                    try:
                        # Validate via discriminated-union root model.
                        event = HarnessEvent.model_validate(payload)
                        await self._event_queue.put(event)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("relay-client.invalid_event", err=str(exc))
                elif kind == "server_message":
                    try:
                        server_message = ServerMessage.model_validate(payload)
                        await self._server_message_queue.put(server_message)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("relay-client.invalid_server_message", err=str(exc))
                        continue

                    # Daemon sends a `harness_state` snapshot on connect so the
                    # orchestrator can seed its inference-gate state without
                    # waiting for the first event flow.
                    if payload.get("type") == "harness_state" and self._on_harness_state:
                        try:
                            await self._on_harness_state(payload)
                        except Exception as exc:  # noqa: BLE001
                            logger.warning(
                                "relay-client.harness_state_callback_error",
                                err=str(exc),
                            )
                # else: silently ignore unknown kinds — forward-compat.
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

    def server_messages(self) -> AsyncIterator[ServerMessage]:
        async def _iter() -> AsyncIterator[ServerMessage]:
            while not self._stopped:
                message = await self._server_message_queue.get()
                yield message

        return _iter()

    async def close(self) -> None:
        self._stopped = True
        if self._reader_task:
            self._reader_task.cancel()
        if self._socket:
            await self._socket.close()
            self._socket = None

    def _envelope_command(self, command: HarnessCommandVariant) -> Envelope:
        return Envelope(
            protocol_version=PROTOCOL_VERSION,
            kind=Kind.harness_command,
            id=os.urandom(8).hex(),
            timestamp=datetime.now(UTC),
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

    async def connect(self) -> None:  # pragma: no cover
        raise NotImplementedError("LocalUDSClient is a Y2 stub")

    async def submit(self, command: HarnessCommandVariant) -> None:  # pragma: no cover
        raise NotImplementedError("LocalUDSClient is a Y2 stub")

    def events(self) -> AsyncIterator[HarnessEvent]:  # pragma: no cover
        async def _iter() -> AsyncIterator[HarnessEvent]:
            if False:  # pragma: no cover
                yield  # type: ignore[unreachable]

        return _iter()

    def server_messages(self) -> AsyncIterator[ServerMessage]:  # pragma: no cover
        async def _iter() -> AsyncIterator[ServerMessage]:
            if False:  # pragma: no cover
                yield  # type: ignore[unreachable]

        return _iter()

    async def close(self) -> None:  # pragma: no cover
        return None

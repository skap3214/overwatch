"""HTTP handlers that bridge Hermes tool calls to Overwatch's local backend."""
from __future__ import annotations

import json
import os
from typing import Any, Dict

try:
    import httpx
except ImportError:  # pragma: no cover - hermes ships httpx; defensive
    httpx = None  # type: ignore[assignment]


def _api_base() -> str:
    return os.environ.get("OVERWATCH_API_BASE", "http://127.0.0.1:8787").rstrip("/")


def _headers() -> Dict[str, str]:
    h: Dict[str, str] = {"Content-Type": "application/json"}
    token = os.environ.get("OVERWATCH_API_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _ok(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


def _err(msg: str, **extra: Any) -> str:
    return json.dumps({"error": msg, **extra}, ensure_ascii=False)


def _need_httpx() -> str | None:
    if httpx is None:
        return _err("httpx is not installed in the Hermes runtime")
    return None


def _request(method: str, path: str, *, body: Any | None = None, params: dict | None = None,
             timeout: float = 15.0) -> str:
    pre = _need_httpx()
    if pre is not None:
        return pre
    try:
        with httpx.Client(timeout=timeout) as client:
            r = client.request(
                method,
                f"{_api_base()}{path}",
                json=body,
                params=params,
                headers=_headers(),
            )
        if r.status_code >= 400:
            return _err(f"Overwatch API {r.status_code}", body=r.text[:500])
        # Return JSON if content-type indicates so, else raw text.
        ctype = r.headers.get("content-type", "")
        if ctype.startswith("application/json"):
            return _ok(r.json())
        return _ok({"text": r.text})
    except httpx.HTTPError as exc:  # type: ignore[union-attr]
        return _err(f"Overwatch HTTP error: {exc}")
    except Exception as exc:  # pragma: no cover - defensive
        return _err(f"Overwatch unexpected error: {exc}")


def _post(path: str, body: dict, *, timeout: float = 15.0) -> str:
    return _request("POST", path, body=body, timeout=timeout)


def _get(path: str, *, params: dict | None = None, timeout: float = 10.0) -> str:
    return _request("GET", path, params=params, timeout=timeout)


def _delete(path: str, *, timeout: float = 10.0) -> str:
    return _request("DELETE", path, timeout=timeout)


# --- Handlers ---------------------------------------------------------------

def tmux_list_sessions(_args: dict, **_kw: Any) -> str:
    return _get("/api/v1/tmux/sessions")


def tmux_list_panes(args: dict, **_kw: Any) -> str:
    session = (args.get("session") or "").strip()
    if not session:
        return _err("session is required")
    return _get(f"/api/v1/tmux/sessions/{session}/panes")


def tmux_send_keys(args: dict, **_kw: Any) -> str:
    session = (args.get("session") or "").strip()
    keys = args.get("keys") or ""
    if not session or not keys:
        return _err("session and keys are required")
    body: Dict[str, Any] = {"session": session, "keys": keys}
    if args.get("pane"):
        body["pane"] = str(args["pane"])
    if args.get("literal") is not None:
        body["literal"] = bool(args["literal"])
    if args.get("submit") is not None:
        body["submit"] = bool(args["submit"])
    return _post("/api/v1/tmux/send-keys", body)


def tmux_read_pane(args: dict, **_kw: Any) -> str:
    session = (args.get("session") or "").strip()
    pane = (args.get("pane") or "").strip()
    if not session or not pane:
        return _err("session and pane are required")
    params = {"lines": int(args.get("lines") or 200)}
    return _get(f"/api/v1/tmux/sessions/{session}/panes/{pane}/read", params=params)


def tmux_create_session(args: dict, **_kw: Any) -> str:
    name = (args.get("name") or "").strip()
    if not name:
        return _err("name is required")
    body: Dict[str, Any] = {"name": name}
    if args.get("command"):
        body["command"] = args["command"]
    return _post("/api/v1/tmux/sessions", body)


def tmux_kill_pane(args: dict, **_kw: Any) -> str:
    session = (args.get("session") or "").strip()
    pane = (args.get("pane") or "").strip()
    if not session or not pane:
        return _err("session and pane are required")
    return _delete(f"/api/v1/tmux/sessions/{session}/panes/{pane}")

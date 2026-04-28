"""Overwatch tmux orchestrator — Hermes plugin.

Exposes Overwatch's tmux HTTP API as Hermes tools so the user's Hermes agent
can drive tmux from any Hermes entrypoint (CLI, dashboard, Discord, Slack).

Configuration (read from environment, set by `overwatch hermes plugin install`):
    OVERWATCH_API_BASE   default: http://127.0.0.1:8787
    OVERWATCH_API_TOKEN  optional bearer token (matches backend OVERWATCH_API_TOKEN)
"""
from __future__ import annotations

import os

from . import schemas, tools


def _has_overwatch_target() -> bool:
    """Gate the toolset on Overwatch backend env var."""
    return bool(os.environ.get("OVERWATCH_API_BASE"))


def register(ctx) -> None:
    common = {"toolset": "overwatch", "check_fn": _has_overwatch_target}

    ctx.register_tool(
        name="tmux_list_sessions",
        schema=schemas.TMUX_LIST_SESSIONS,
        handler=tools.tmux_list_sessions,
        description="List all tmux sessions managed by Overwatch on the user's Mac.",
        emoji="📋",
        **common,
    )
    ctx.register_tool(
        name="tmux_list_panes",
        schema=schemas.TMUX_LIST_PANES,
        handler=tools.tmux_list_panes,
        description="List panes in an Overwatch tmux session.",
        emoji="🪟",
        **common,
    )
    ctx.register_tool(
        name="tmux_send_keys",
        schema=schemas.TMUX_SEND_KEYS,
        handler=tools.tmux_send_keys,
        description=(
            "Send keystrokes to a tmux pane via Overwatch. "
            "Use `literal: true` for typed text (Codex/Cursor prompts) and "
            "`submit: true` to send a separate Enter after."
        ),
        emoji="⌨️",
        **common,
    )
    ctx.register_tool(
        name="tmux_read_pane",
        schema=schemas.TMUX_READ_PANE,
        handler=tools.tmux_read_pane,
        description="Read scrollback content of a tmux pane via Overwatch.",
        emoji="📖",
        **common,
    )
    ctx.register_tool(
        name="tmux_create_session",
        schema=schemas.TMUX_CREATE_SESSION,
        handler=tools.tmux_create_session,
        description="Create a new Overwatch-managed tmux session.",
        emoji="✨",
        **common,
    )
    ctx.register_tool(
        name="tmux_kill_pane",
        schema=schemas.TMUX_KILL_PANE,
        handler=tools.tmux_kill_pane,
        description="Terminate an Overwatch tmux pane.",
        emoji="🪓",
        **common,
    )

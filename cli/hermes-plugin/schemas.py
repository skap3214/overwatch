"""JSON Schema definitions for Overwatch tools exposed to Hermes."""

TMUX_LIST_SESSIONS = {
    "name": "tmux_list_sessions",
    "description": "List all tmux sessions tracked by Overwatch.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}

TMUX_LIST_PANES = {
    "name": "tmux_list_panes",
    "description": "List panes in an Overwatch tmux session.",
    "parameters": {
        "type": "object",
        "properties": {
            "session": {
                "type": "string",
                "description": "Overwatch session name (e.g. 'main', 'codex-1').",
            },
        },
        "required": ["session"],
    },
}

TMUX_SEND_KEYS = {
    "name": "tmux_send_keys",
    "description": (
        "Send keystrokes to a tmux pane managed by Overwatch.\n\n"
        "- For control sequences: keys=\"C-c\", \"Enter\", \"Up\", etc.\n"
        "- For typed text into Codex/Cursor prompts: set literal=true and "
        "submit=true so the text goes in literal mode and a separate Enter is sent.\n"
        "- For Claude Code / OpenCode: literal=false works fine.\n"
        "Returns success status and any backend error."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session": {
                "type": "string",
                "description": "Overwatch session name.",
            },
            "keys": {
                "type": "string",
                "description": "Keys to send. Tmux key spec or literal text.",
            },
            "pane": {
                "type": "string",
                "description": "Optional pane id within the session (e.g. '1' or '0.1'). Defaults to the active pane.",
            },
            "literal": {
                "type": "boolean",
                "description": "Send keys verbatim (typed text) rather than as a tmux key spec. Default false.",
            },
            "submit": {
                "type": "boolean",
                "description": "Send a separate Enter keystroke after `keys`. Use with literal=true for Codex/Cursor.",
            },
        },
        "required": ["session", "keys"],
    },
}

TMUX_READ_PANE = {
    "name": "tmux_read_pane",
    "description": (
        "Read the visible/scrollback content of a tmux pane via Overwatch. "
        "Returns the raw text. Use this to check if an agent is still working, "
        "blocked on a permission prompt, finished, or errored."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session": {
                "type": "string",
                "description": "Overwatch session name.",
            },
            "pane": {
                "type": "string",
                "description": "Pane id (e.g. '1'). Required.",
            },
            "lines": {
                "type": "number",
                "description": "Lines of scrollback to return (default 200, max 5000).",
            },
        },
        "required": ["session", "pane"],
    },
}

TMUX_CREATE_SESSION = {
    "name": "tmux_create_session",
    "description": "Create a new Overwatch-managed tmux session.",
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Session name. Must be unique.",
            },
            "command": {
                "type": "string",
                "description": "Optional command to run in the new session (e.g. 'codex' or 'claude').",
            },
        },
        "required": ["name"],
    },
}

TMUX_KILL_PANE = {
    "name": "tmux_kill_pane",
    "description": "Terminate an Overwatch tmux pane.",
    "parameters": {
        "type": "object",
        "properties": {
            "session": {"type": "string", "description": "Overwatch session name."},
            "pane": {"type": "string", "description": "Pane id."},
        },
        "required": ["session", "pane"],
    },
}

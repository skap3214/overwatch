"""Cartesia voice registry — small dict of friendly name → voice UUID."""

VOICES: dict[str, str] = {
    # Cartesia pre-built voices. Update via Cartesia dashboard.
    "brooke": "a0e99841-438c-4a64-b679-ae501e7d6091",
    "newsman": "d46abd1d-2d02-43e8-819f-51fb652c1c61",
    "calm": "3f4ade23-6eb4-4279-ab05-6a144947c4d5",
}

DEFAULT_VOICE = "brooke"


def resolve_voice_id(name_or_id: str) -> str:
    """Accept either a friendly name from VOICES or a raw UUID."""
    if name_or_id in VOICES:
        return VOICES[name_or_id]
    return name_or_id

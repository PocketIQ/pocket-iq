"""
ElevenLabs text-to-speech: the coach reads its advice out loud, so the player can keep
both hands on the cue instead of reading a phone propped on the rail.
"""
import os

import httpx

TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}"


class VoiceError(Exception):
    """Couldn't make audio. Message is shown to the user."""


def speak(text: str) -> bytes:
    """MP3 bytes of `text` read aloud."""
    key = os.getenv("ELEVENLABS_API_KEY", "")
    if not key or "your-key" in key:
        raise VoiceError("Voice isn't set up: put ELEVENLABS_API_KEY in backend/.env.")
    voice = os.getenv("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
    try:
        r = httpx.post(
            TTS_URL.format(voice=voice),
            params={"output_format": "mp3_44100_128"},
            headers={"xi-api-key": key},
            json={"text": text, "model_id": os.getenv("ELEVENLABS_MODEL", "eleven_multilingual_v2")},
            timeout=30,
        )
    except httpx.HTTPError as e:
        raise VoiceError(f"Couldn't reach ElevenLabs: {e}") from e
    if r.status_code >= 400:
        raise VoiceError(f"ElevenLabs couldn't read that out ({r.status_code}): {r.text[:200]}")
    return r.content

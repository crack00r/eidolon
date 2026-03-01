"""Text-to-Speech endpoint (Qwen3-TTS stub)."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

router = APIRouter()

# Maximum text length for a single TTS request
MAX_TTS_TEXT_LENGTH = 10_000

# Valid TTS output formats
VALID_TTS_FORMATS = {"opus", "wav", "mp3"}

# Speed range
MIN_TTS_SPEED = 0.25
MAX_TTS_SPEED = 4.0


class TtsRequest(BaseModel):
    """TTS synthesis request."""

    text: str
    voice: str = "default"
    speed: float = 1.0
    format: str = "opus"  # opus, wav, mp3

    @field_validator("text")
    @classmethod
    def validate_text(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Text must not be empty")
        if len(v) > MAX_TTS_TEXT_LENGTH:
            raise ValueError(f"Text too long: {len(v)} characters (max {MAX_TTS_TEXT_LENGTH})")
        return v

    @field_validator("speed")
    @classmethod
    def validate_speed(cls, v: float) -> float:
        if v < MIN_TTS_SPEED or v > MAX_TTS_SPEED:
            raise ValueError(f"Speed out of range: {v} (must be {MIN_TTS_SPEED}-{MAX_TTS_SPEED})")
        return v

    @field_validator("format")
    @classmethod
    def validate_format(cls, v: str) -> str:
        if v not in VALID_TTS_FORMATS:
            raise ValueError(f"Invalid format: {v} (must be one of {VALID_TTS_FORMATS})")
        return v


class TtsResponse(BaseModel):
    """TTS synthesis response."""

    status: str
    message: str


@router.post("/synthesize")
async def synthesize(request: TtsRequest) -> TtsResponse:
    """Synthesize text to speech. Stub: model not loaded."""
    return TtsResponse(
        status="unavailable",
        message="TTS model not loaded. Install GPU dependencies and configure the model.",
    )


@router.post("/stream")
async def stream_tts(request: TtsRequest):
    """Stream TTS audio. Stub: not implemented."""
    raise HTTPException(
        status_code=503,
        detail="TTS streaming not available. Model not loaded.",
    )

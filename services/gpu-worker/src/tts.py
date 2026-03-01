"""Text-to-Speech endpoint (Qwen3-TTS stub)."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class TtsRequest(BaseModel):
    """TTS synthesis request."""

    text: str
    voice: str = "default"
    speed: float = 1.0
    format: str = "opus"  # opus, wav, mp3


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

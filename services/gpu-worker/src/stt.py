"""Speech-to-Text endpoint (faster-whisper stub)."""

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

router = APIRouter()


class SttResponse(BaseModel):
    """STT transcription response."""

    text: str
    language: str
    confidence: float
    duration_seconds: float


@router.post("/transcribe")
async def transcribe(file: UploadFile) -> SttResponse:
    """Transcribe audio to text. Stub: model not loaded."""
    raise HTTPException(
        status_code=503,
        detail="STT model not loaded. Install GPU dependencies.",
    )

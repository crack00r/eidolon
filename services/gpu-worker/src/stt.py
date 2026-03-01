"""Speech-to-Text endpoint (faster-whisper stub)."""

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

router = APIRouter()

# Maximum upload file size for STT: 25 MB
MAX_STT_UPLOAD_BYTES = 25 * 1024 * 1024

# Supported audio MIME types
ALLOWED_STT_CONTENT_TYPES = {
    "audio/wav",
    "audio/wave",
    "audio/x-wav",
    "audio/mp3",
    "audio/mpeg",
    "audio/ogg",
    "audio/opus",
    "audio/webm",
    "audio/flac",
    "audio/x-flac",
    "application/octet-stream",  # fallback for clients that don't set MIME
}


class SttResponse(BaseModel):
    """STT transcription response."""

    text: str
    language: str
    confidence: float
    duration_seconds: float


@router.post("/transcribe")
async def transcribe(file: UploadFile) -> SttResponse:
    """Transcribe audio to text. Stub: model not loaded."""
    # Validate content type
    if file.content_type and file.content_type not in ALLOWED_STT_CONTENT_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported audio type: {file.content_type}",
        )

    # Validate file size (read size from headers if available)
    if file.size is not None and file.size > MAX_STT_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio file too large: {file.size} bytes (max {MAX_STT_UPLOAD_BYTES})",
        )

    raise HTTPException(
        status_code=503,
        detail="STT model not loaded. Install GPU dependencies.",
    )

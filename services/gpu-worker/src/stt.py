"""Speech-to-Text endpoint (faster-whisper stub)."""

import logging

from fastapi import APIRouter, HTTPException, Request, UploadFile
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger("eidolon.gpu.stt")

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
async def transcribe(file: UploadFile, request: Request) -> SttResponse:
    """Transcribe audio to text. Stub: model not loaded."""
    request_id = getattr(request.state, "request_id", "unknown")

    # Validate content type
    if file.content_type and file.content_type not in ALLOWED_STT_CONTENT_TYPES:
        logger.warning(
            "Rejected unsupported audio type: %s",
            file.content_type,
            extra={"request_id": request_id},
        )
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported audio type: {file.content_type}",
        )

    # Validate file size (read size from headers if available)
    if file.size is not None and file.size > MAX_STT_UPLOAD_BYTES:
        logger.warning(
            "Rejected oversized audio file: %d bytes (max %d)",
            file.size,
            MAX_STT_UPLOAD_BYTES,
            extra={"request_id": request_id},
        )
        raise HTTPException(
            status_code=413,
            detail=f"Audio file too large: {file.size} bytes (max {MAX_STT_UPLOAD_BYTES})",
        )

    logger.info(
        "STT transcription requested (content_type=%s, size=%s) — model not loaded",
        file.content_type or "unknown",
        file.size,
        extra={"request_id": request_id},
    )

    raise HTTPException(
        status_code=503,
        detail="STT model not loaded. Install GPU dependencies.",
    )

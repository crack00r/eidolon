"""Eidolon GPU Worker -- FastAPI service for TTS/STT."""

from fastapi import FastAPI

from .auth import AuthMiddleware
from .health import router as health_router
from .stt import router as stt_router
from .tts import router as tts_router

app = FastAPI(
    title="Eidolon GPU Worker",
    version="0.1.0",
    description="GPU-accelerated TTS and STT for Eidolon",
)

# Auth middleware
app.add_middleware(AuthMiddleware)

# Routes
app.include_router(health_router, prefix="/health", tags=["health"])
app.include_router(tts_router, prefix="/tts", tags=["tts"])
app.include_router(stt_router, prefix="/stt", tags=["stt"])

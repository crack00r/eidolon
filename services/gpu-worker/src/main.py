"""Eidolon GPU Worker -- FastAPI service for TTS/STT."""

import logging
import os
import platform
import sys
import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .auth import AuthMiddleware
from .health import router as health_router
from .logging_config import configure_logging
from .stt import router as stt_router
from .tts import router as tts_router
from .voice_ws import router as voice_ws_router

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

configure_logging(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("eidolon.gpu.main")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Maximum request body size: 50 MB (generous for audio uploads)
MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024


# ---------------------------------------------------------------------------
# Request ID middleware
# ---------------------------------------------------------------------------


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Generate a UUID for each request, attach to logs, return in headers."""

    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        request.state.request_id = request_id

        response: Response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response


# ---------------------------------------------------------------------------
# Security headers middleware
# ---------------------------------------------------------------------------


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add standard security headers to all responses."""

    async def dispatch(self, request: Request, call_next) -> Response:
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "0"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = "default-src 'none'"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response


# ---------------------------------------------------------------------------
# Request body size limit middleware
# ---------------------------------------------------------------------------


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject requests exceeding the configured body size limit.

    Checks Content-Length header first for an early reject, then wraps the
    ASGI receive channel with a byte counter to enforce the limit even for
    chunked transfer-encoding requests that omit Content-Length.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        # Fast-path: reject immediately when Content-Length exceeds the limit
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_REQUEST_BODY_BYTES:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "Request body too large"},
                    )
            except ValueError:
                pass

        # Wrap the receive channel to enforce byte limit on streamed bodies
        received_bytes = 0

        original_receive = request.receive

        async def limited_receive():
            nonlocal received_bytes
            message = await original_receive()
            if message.get("type") == "http.request":
                body = message.get("body", b"")
                received_bytes += len(body)
                if received_bytes > MAX_REQUEST_BODY_BYTES:
                    raise ValueError("Request body too large")
            return message

        request._receive = limited_receive  # type: ignore[attr-defined]

        try:
            return await call_next(request)
        except ValueError as exc:
            if "Request body too large" in str(exc):
                return JSONResponse(
                    status_code=413,
                    content={"detail": "Request body too large"},
                )
            raise


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Eidolon GPU Worker",
    version="0.1.0",
    description="GPU-accelerated TTS and STT for Eidolon",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# Middleware (applied in reverse order — last added runs first)
app.add_middleware(AuthMiddleware)
app.add_middleware(RequestSizeLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestIdMiddleware)

# Routes
app.include_router(health_router, prefix="/health", tags=["health"])
app.include_router(tts_router, prefix="/tts", tags=["tts"])
app.include_router(stt_router, prefix="/stt", tags=["stt"])
app.include_router(voice_ws_router, prefix="/voice", tags=["voice"])


# ---------------------------------------------------------------------------
# Startup event
# ---------------------------------------------------------------------------


@app.on_event("startup")
async def _on_startup() -> None:
    """Log configuration and environment on startup."""
    # Check CUDA availability
    cuda_available = False
    cuda_version = None
    try:
        import torch

        cuda_available = torch.cuda.is_available()
        if cuda_available:
            cuda_version = torch.version.cuda
    except ImportError:
        pass

    logger.info(
        "Eidolon GPU Worker starting",
        extra={
            "data": {
                "python_version": platform.python_version(),
                "platform": platform.platform(),
                "cuda_available": cuda_available,
                "cuda_version": cuda_version,
                "pid": os.getpid(),
                "log_level": os.environ.get("LOG_LEVEL", "INFO"),
                "api_key_configured": bool(os.environ.get("EIDOLON_GPU_API_KEY", "").strip()),
            }
        },
    )

    if not cuda_available:
        logger.warning("CUDA is not available — GPU-accelerated inference will not work")

    if not os.environ.get("EIDOLON_GPU_API_KEY", "").strip():
        logger.warning("EIDOLON_GPU_API_KEY is not set — all authenticated endpoints will return 503")

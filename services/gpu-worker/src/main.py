"""Eidolon GPU Worker -- FastAPI service for TTS/STT."""

from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .auth import AuthMiddleware
from .health import router as health_router
from .stt import router as stt_router
from .tts import router as tts_router

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Maximum request body size: 50 MB (generous for audio uploads)
MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024


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
    """Reject requests with Content-Length exceeding the configured limit."""

    async def dispatch(self, request: Request, call_next) -> Response:
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_REQUEST_BODY_BYTES:
                    return Response(
                        content='{"error": "Request body too large"}',
                        status_code=413,
                        media_type="application/json",
                    )
            except ValueError:
                pass
        return await call_next(request)


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

# Routes
app.include_router(health_router, prefix="/health", tags=["health"])
app.include_router(tts_router, prefix="/tts", tags=["tts"])
app.include_router(stt_router, prefix="/stt", tags=["stt"])

"""Pre-shared key authentication middleware."""

import hmac
import logging
import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger("eidolon.gpu.auth")


class AuthMiddleware(BaseHTTPMiddleware):
    """Validates X-API-Key header against EIDOLON_GPU_API_KEY env var."""

    async def dispatch(self, request: Request, call_next):
        # Exact match for health endpoint path — skip auth
        if request.url.path == "/health":
            return await call_next(request)

        request_id = getattr(request.state, "request_id", "unknown")

        api_key = os.environ.get("EIDOLON_GPU_API_KEY", "").strip()
        if not api_key:
            logger.error(
                "EIDOLON_GPU_API_KEY not configured — rejecting request to %s",
                request.url.path,
                extra={"request_id": request_id},
            )
            return JSONResponse(
                status_code=503,
                content={"detail": "Authentication not configured"},
            )

        provided_key = (request.headers.get("X-API-Key") or "").strip()
        # Constant-time comparison to prevent timing attacks
        if not provided_key or not hmac.compare_digest(provided_key, api_key):
            client_ip = request.client.host if request.client else "unknown"
            logger.warning(
                "Auth failure from %s on %s %s — invalid or missing API key",
                client_ip,
                request.method,
                request.url.path,
                extra={"request_id": request_id},
            )
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or missing API key"},
            )

        return await call_next(request)

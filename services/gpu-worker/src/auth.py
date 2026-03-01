"""Pre-shared key authentication middleware."""

import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


class AuthMiddleware(BaseHTTPMiddleware):
    """Validates X-API-Key header against EIDOLON_GPU_API_KEY env var."""

    async def dispatch(self, request: Request, call_next):
        # Skip auth for health endpoint
        if request.url.path.startswith("/health"):
            return await call_next(request)

        api_key = os.environ.get("EIDOLON_GPU_API_KEY")
        if not api_key:
            if request.url.path == "/health":
                return await call_next(request)
            return JSONResponse(
                status_code=503,
                content={"error": "EIDOLON_GPU_API_KEY not configured. Authentication required."},
            )

        provided_key = request.headers.get("X-API-Key")
        if provided_key != api_key:
            return JSONResponse(
                status_code=401,
                content={"error": "Invalid or missing API key"},
            )

        return await call_next(request)

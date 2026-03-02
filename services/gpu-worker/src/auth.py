"""Pre-shared key authentication middleware with per-IP rate limiting."""

import hmac
import logging
import os
import time
from collections import defaultdict
from typing import Dict, Tuple

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger("eidolon.gpu.auth")

# ---------------------------------------------------------------------------
# Auth failure rate limiter
# ---------------------------------------------------------------------------

# Maximum auth failures per IP before temporary block
_AUTH_FAILURE_MAX = 5
# Rate limit window in seconds (1 minute)
_AUTH_FAILURE_WINDOW_SECONDS = 60


class _AuthFailureTracker:
    """Simple in-memory tracker for authentication failures per IP.

    Blocks IPs that exceed ``_AUTH_FAILURE_MAX`` failures within
    ``_AUTH_FAILURE_WINDOW_SECONDS``.
    """

    def __init__(self) -> None:
        # ip -> (failure_count, window_start_timestamp)
        self._buckets: Dict[str, Tuple[int, float]] = {}

    def is_blocked(self, ip: str) -> bool:
        """Return True if the IP has exceeded the failure threshold."""
        bucket = self._buckets.get(ip)
        if bucket is None:
            return False
        count, window_start = bucket
        # Window expired — reset
        if time.monotonic() - window_start > _AUTH_FAILURE_WINDOW_SECONDS:
            del self._buckets[ip]
            return False
        return count >= _AUTH_FAILURE_MAX

    def record_failure(self, ip: str) -> None:
        """Record an auth failure for the given IP."""
        now = time.monotonic()
        bucket = self._buckets.get(ip)
        if bucket is None or now - bucket[1] > _AUTH_FAILURE_WINDOW_SECONDS:
            self._buckets[ip] = (1, now)
        else:
            self._buckets[ip] = (bucket[0] + 1, bucket[1])
        count = self._buckets[ip][0]
        if count >= _AUTH_FAILURE_MAX:
            logger.warning(
                "Auth rate limit triggered for IP %s — %d failures in window",
                ip,
                count,
            )

    def record_success(self, ip: str) -> None:
        """Clear failure state on successful auth."""
        self._buckets.pop(ip, None)


# Module-level singleton so state is shared across requests
_failure_tracker = _AuthFailureTracker()


class AuthMiddleware(BaseHTTPMiddleware):
    """Validates X-API-Key header against EIDOLON_GPU_API_KEY env var.

    Includes per-IP rate limiting on auth failures (max 5 per minute).
    """

    async def dispatch(self, request: Request, call_next):
        # Exact match for health endpoint path — skip auth
        if request.url.path == "/health":
            return await call_next(request)

        request_id = getattr(request.state, "request_id", "unknown")
        client_ip = request.client.host if request.client else "unknown"

        # Check if IP is rate-limited due to previous auth failures
        if _failure_tracker.is_blocked(client_ip):
            logger.warning(
                "Auth rate-limited IP %s attempted request to %s %s",
                client_ip,
                request.method,
                request.url.path,
                extra={"request_id": request_id},
            )
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many authentication failures"},
            )

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
            _failure_tracker.record_failure(client_ip)
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

        _failure_tracker.record_success(client_ip)
        return await call_next(request)

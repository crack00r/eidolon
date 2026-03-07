"""Tests for request middleware (security headers, request ID, size limits)."""

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture
def client():
    return TestClient(app)


class TestSecurityHeaders:
    """SecurityHeadersMiddleware adds standard security headers."""

    def test_x_content_type_options(self, client):
        response = client.get("/health")
        assert response.headers.get("X-Content-Type-Options") == "nosniff"

    def test_x_frame_options(self, client):
        response = client.get("/health")
        assert response.headers.get("X-Frame-Options") == "DENY"

    def test_x_xss_protection(self, client):
        response = client.get("/health")
        assert response.headers.get("X-XSS-Protection") == "0"

    def test_cache_control(self, client):
        response = client.get("/health")
        assert response.headers.get("Cache-Control") == "no-store"

    def test_content_security_policy(self, client):
        response = client.get("/health")
        assert response.headers.get("Content-Security-Policy") == "default-src 'none'"

    def test_referrer_policy(self, client):
        response = client.get("/health")
        assert response.headers.get("Referrer-Policy") == "no-referrer"


class TestRequestIdMiddleware:
    """RequestIdMiddleware generates or passes through request IDs."""

    def test_generates_request_id(self, client):
        response = client.get("/health")
        request_id = response.headers.get("X-Request-ID")
        assert request_id is not None
        assert len(request_id) > 0

    def test_passes_through_provided_request_id(self, client):
        custom_id = "my-custom-request-id-123"
        response = client.get("/health", headers={"X-Request-ID": custom_id})
        assert response.headers.get("X-Request-ID") == custom_id

    def test_unique_request_ids(self, client):
        resp1 = client.get("/health")
        resp2 = client.get("/health")
        id1 = resp1.headers.get("X-Request-ID")
        id2 = resp2.headers.get("X-Request-ID")
        assert id1 != id2


class TestRequestSizeLimitMiddleware:
    """RequestSizeLimitMiddleware rejects oversized request bodies."""

    def test_rejects_oversized_content_length(self, client_with_auth, auth_headers):
        """Request with Content-Length exceeding 50MB should be rejected."""
        # We declare a huge Content-Length but send minimal data
        headers = {**auth_headers, "Content-Length": str(60 * 1024 * 1024)}
        response = client_with_auth.post(
            "/tts/synthesize",
            content=b'{"text": "hello"}',
            headers=headers,
        )
        assert response.status_code == 413
        assert "too large" in response.json()["detail"].lower()

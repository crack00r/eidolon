"""Tests for authentication middleware and rate limiting."""

import os
import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from src.auth import _AuthFailureTracker
from src.main import app


class TestAuthMiddleware:
    """X-API-Key header validation."""

    def test_health_exempt_from_auth(self, client_no_auth):
        """Health endpoint should be accessible without auth."""
        response = client_no_auth.get("/health")
        assert response.status_code == 200

    def test_tts_requires_auth(self, client_no_auth):
        """TTS endpoint should return 503 when no API key is configured."""
        response = client_no_auth.post(
            "/tts/synthesize",
            json={"text": "hello", "voice": "default", "speed": 1.0, "format": "opus"},
        )
        assert response.status_code == 503
        assert "not configured" in response.json()["detail"].lower()

    def test_valid_api_key_allows_request(self, client_with_auth, auth_headers):
        """Request with valid API key should pass through to the handler."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "hello", "voice": "default", "speed": 1.0, "format": "opus"},
            headers=auth_headers,
        )
        # Should reach the handler (200) not be blocked by auth
        assert response.status_code == 200

    def test_invalid_api_key_returns_401(self, client_with_auth):
        """Request with wrong API key should return 401."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "hello"},
            headers={"X-API-Key": "wrong-key"},
        )
        assert response.status_code == 401
        assert "invalid" in response.json()["detail"].lower()

    def test_missing_api_key_header_returns_401(self, client_with_auth):
        """Request without X-API-Key header should return 401."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "hello"},
        )
        assert response.status_code == 401

    def test_empty_api_key_header_returns_401(self, client_with_auth):
        """Request with empty X-API-Key header should return 401."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "hello"},
            headers={"X-API-Key": ""},
        )
        assert response.status_code == 401


class TestAuthFailureTracker:
    """Per-IP rate limiting on auth failures."""

    def test_new_ip_is_not_blocked(self):
        tracker = _AuthFailureTracker()
        assert tracker.is_blocked("1.2.3.4") is False

    def test_ip_blocked_after_max_failures(self):
        tracker = _AuthFailureTracker()
        for _ in range(5):
            tracker.record_failure("1.2.3.4")
        assert tracker.is_blocked("1.2.3.4") is True

    def test_ip_not_blocked_below_threshold(self):
        tracker = _AuthFailureTracker()
        for _ in range(4):
            tracker.record_failure("1.2.3.4")
        assert tracker.is_blocked("1.2.3.4") is False

    def test_success_clears_failure_state(self):
        tracker = _AuthFailureTracker()
        for _ in range(5):
            tracker.record_failure("1.2.3.4")
        assert tracker.is_blocked("1.2.3.4") is True
        tracker.record_success("1.2.3.4")
        assert tracker.is_blocked("1.2.3.4") is False

    def test_different_ips_tracked_independently(self):
        tracker = _AuthFailureTracker()
        for _ in range(5):
            tracker.record_failure("1.1.1.1")
        assert tracker.is_blocked("1.1.1.1") is True
        assert tracker.is_blocked("2.2.2.2") is False

    def test_window_expiry_resets_block(self):
        tracker = _AuthFailureTracker()
        for _ in range(5):
            tracker.record_failure("1.2.3.4")
        assert tracker.is_blocked("1.2.3.4") is True

        # Simulate window expiry by manipulating the bucket timestamp
        ip_bucket = tracker._buckets["1.2.3.4"]
        tracker._buckets["1.2.3.4"] = (ip_bucket[0], time.monotonic() - 61)
        assert tracker.is_blocked("1.2.3.4") is False

    def test_rate_limited_ip_gets_429(self, client_with_auth, monkeypatch):
        """After 5 failures, subsequent requests get 429."""
        from src.auth import _failure_tracker
        _failure_tracker._buckets.clear()

        # Make 5 failed auth attempts
        for _ in range(5):
            client_with_auth.post(
                "/tts/synthesize",
                json={"text": "hello"},
                headers={"X-API-Key": "bad-key"},
            )

        # 6th attempt should be rate limited
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "hello"},
            headers={"X-API-Key": "bad-key"},
        )
        assert response.status_code == 429
        assert "too many" in response.json()["detail"].lower()

"""Tests for TTS endpoint request validation."""

import pytest


class TestTtsRequestValidation:
    """POST /tts/synthesize -- validates TtsRequest model."""

    def test_valid_request_returns_200(self, client_with_auth, auth_headers):
        """Valid TTS request should be accepted (returns unavailable stub)."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "Hello world", "voice": "default", "speed": 1.0, "format": "opus"},
            headers=auth_headers,
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "unavailable"
        assert "not loaded" in data["message"].lower()

    def test_minimal_request_uses_defaults(self, client_with_auth, auth_headers):
        """Only 'text' is required; other fields use defaults."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "Test"},
            headers=auth_headers,
        )
        assert response.status_code == 200

    def test_empty_text_returns_422(self, client_with_auth, auth_headers):
        """Empty text should be rejected."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": ""},
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_whitespace_only_text_returns_422(self, client_with_auth, auth_headers):
        """Whitespace-only text should be rejected."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "   "},
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_text_too_long_returns_422(self, client_with_auth, auth_headers):
        """Text exceeding 10000 chars should be rejected."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "a" * 10001},
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_text_at_max_length_accepted(self, client_with_auth, auth_headers):
        """Text at exactly 10000 chars should be accepted."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "a" * 10000},
            headers=auth_headers,
        )
        assert response.status_code == 200

    def test_speed_too_low_returns_422(self, client_with_auth, auth_headers):
        """Speed below 0.25 should be rejected."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "hello", "speed": 0.1},
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_speed_too_high_returns_422(self, client_with_auth, auth_headers):
        """Speed above 4.0 should be rejected."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "hello", "speed": 5.0},
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_speed_at_boundaries(self, client_with_auth, auth_headers):
        """Speed at 0.25 and 4.0 should be accepted."""
        resp_low = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "hello", "speed": 0.25},
            headers=auth_headers,
        )
        assert resp_low.status_code == 200

        resp_high = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "hello", "speed": 4.0},
            headers=auth_headers,
        )
        assert resp_high.status_code == 200

    def test_invalid_format_returns_422(self, client_with_auth, auth_headers):
        """Invalid audio format should be rejected."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"text": "hello", "format": "aac"},
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_valid_formats_accepted(self, client_with_auth, auth_headers):
        """All supported formats should be accepted."""
        for fmt in ["opus", "wav", "mp3"]:
            response = client_with_auth.post(
                "/tts/synthesize",
                json={"text": "hello", "format": fmt},
                headers=auth_headers,
            )
            assert response.status_code == 200, f"Format {fmt} should be accepted"

    def test_missing_text_returns_422(self, client_with_auth, auth_headers):
        """Request without text field should be rejected."""
        response = client_with_auth.post(
            "/tts/synthesize",
            json={"voice": "default"},
            headers=auth_headers,
        )
        assert response.status_code == 422


class TestTtsStream:
    """POST /tts/stream -- stub endpoint."""

    def test_stream_returns_503(self, client_with_auth, auth_headers):
        """Stream endpoint should return 503 (not implemented)."""
        response = client_with_auth.post(
            "/tts/stream",
            json={"text": "hello"},
            headers=auth_headers,
        )
        assert response.status_code == 503
        assert "not available" in response.json()["detail"].lower()

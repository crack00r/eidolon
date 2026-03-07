"""Tests for STT endpoint request validation."""

import io

import pytest


class TestSttTranscribe:
    """POST /stt/transcribe -- file upload validation."""

    def test_valid_audio_upload_returns_503(self, client_with_auth, auth_headers):
        """Valid audio upload should reach handler but return 503 (model not loaded)."""
        audio_data = b"\x00" * 1024  # Fake audio bytes
        response = client_with_auth.post(
            "/stt/transcribe",
            files={"file": ("audio.wav", io.BytesIO(audio_data), "audio/wav")},
            headers=auth_headers,
        )
        assert response.status_code == 503
        assert "not loaded" in response.json()["detail"].lower()

    def test_unsupported_content_type_returns_415(self, client_with_auth, auth_headers):
        """Unsupported audio MIME type should be rejected."""
        response = client_with_auth.post(
            "/stt/transcribe",
            files={"file": ("file.txt", io.BytesIO(b"hello"), "text/plain")},
            headers=auth_headers,
        )
        assert response.status_code == 415
        assert "unsupported" in response.json()["detail"].lower()

    def test_supported_content_types_accepted(self, client_with_auth, auth_headers):
        """All supported audio types should pass content type validation."""
        supported_types = [
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
            "application/octet-stream",
        ]
        for ct in supported_types:
            response = client_with_auth.post(
                "/stt/transcribe",
                files={"file": ("audio.bin", io.BytesIO(b"\x00" * 100), ct)},
                headers=auth_headers,
            )
            # Should reach the handler (503 because model not loaded), not 415
            assert response.status_code == 503, f"Content type {ct} should be accepted"

    def test_no_file_returns_422(self, client_with_auth, auth_headers):
        """Request without file upload should return 422."""
        response = client_with_auth.post(
            "/stt/transcribe",
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_requires_auth(self, client_no_auth):
        """STT endpoint should require authentication."""
        audio_data = b"\x00" * 100
        response = client_no_auth.post(
            "/stt/transcribe",
            files={"file": ("audio.wav", io.BytesIO(audio_data), "audio/wav")},
        )
        # 503 because no API key configured
        assert response.status_code == 503

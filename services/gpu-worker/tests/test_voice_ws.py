"""Tests for voice WebSocket helper functions."""

import math
import struct

import pytest

from src.voice_ws import (
    VoiceState,
    _compute_rms_energy,
    _validate_token,
)


class TestValidateToken:
    """Token validation for WebSocket auth."""

    def test_valid_token(self, monkeypatch):
        monkeypatch.setenv("EIDOLON_GPU_API_KEY", "secret123")
        assert _validate_token("secret123") is True

    def test_invalid_token(self, monkeypatch):
        monkeypatch.setenv("EIDOLON_GPU_API_KEY", "secret123")
        assert _validate_token("wrong") is False

    def test_empty_token(self, monkeypatch):
        monkeypatch.setenv("EIDOLON_GPU_API_KEY", "secret123")
        assert _validate_token("") is False

    def test_none_token(self, monkeypatch):
        monkeypatch.setenv("EIDOLON_GPU_API_KEY", "secret123")
        assert _validate_token(None) is False

    def test_no_api_key_configured(self, monkeypatch):
        monkeypatch.delenv("EIDOLON_GPU_API_KEY", raising=False)
        assert _validate_token("anything") is False

    def test_whitespace_token_stripped(self, monkeypatch):
        monkeypatch.setenv("EIDOLON_GPU_API_KEY", "secret123")
        assert _validate_token("  secret123  ") is True

    def test_whitespace_only_token_rejected(self, monkeypatch):
        monkeypatch.setenv("EIDOLON_GPU_API_KEY", "secret123")
        assert _validate_token("   ") is False


class TestComputeRmsEnergy:
    """RMS energy computation from audio data."""

    def test_empty_data_returns_zero(self):
        assert _compute_rms_energy(b"") == 0.0

    def test_single_byte_returns_zero(self):
        assert _compute_rms_energy(b"\x00") == 0.0

    def test_silence_pcm_returns_zero(self):
        """16-bit PCM silence (all zeros) should have zero energy."""
        silence = struct.pack("<4h", 0, 0, 0, 0)
        assert _compute_rms_energy(silence) == 0.0

    def test_loud_pcm_returns_high_energy(self):
        """Loud 16-bit PCM samples should have high energy."""
        loud = struct.pack("<4h", 32000, -32000, 32000, -32000)
        energy = _compute_rms_energy(loud)
        assert energy > 30000

    def test_mixed_signal_energy(self):
        """A mix of values should produce intermediate energy."""
        data = struct.pack("<4h", 1000, -1000, 500, -500)
        energy = _compute_rms_energy(data)
        # RMS of [1000, -1000, 500, -500]
        expected = math.sqrt((1000**2 + 1000**2 + 500**2 + 500**2) / 4)
        assert abs(energy - expected) < 1.0

    def test_odd_length_data_handled(self):
        """Odd number of bytes should not crash."""
        data = b"\x00\x01\x02"
        energy = _compute_rms_energy(data)
        assert isinstance(energy, float)
        assert energy >= 0


class TestVoiceState:
    """VoiceState enum values."""

    def test_state_values(self):
        assert VoiceState.IDLE.value == "idle"
        assert VoiceState.LISTENING.value == "listening"
        assert VoiceState.PROCESSING.value == "processing"
        assert VoiceState.SPEAKING.value == "speaking"
        assert VoiceState.INTERRUPTED.value == "interrupted"

    def test_state_is_string_enum(self):
        """VoiceState values should be usable as strings."""
        assert isinstance(VoiceState.IDLE, str)
        assert VoiceState.IDLE == "idle"

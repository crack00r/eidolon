"""Shared fixtures for GPU worker tests."""

import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _reset_env(monkeypatch):
    """Ensure each test starts with a clean environment."""
    # Remove API key by default -- tests that need it set it explicitly
    monkeypatch.delenv("EIDOLON_GPU_API_KEY", raising=False)


@pytest.fixture
def api_key():
    """Return a test API key value."""
    return "test-secret-key-12345"


@pytest.fixture
def client_with_auth(monkeypatch, api_key):
    """TestClient with a valid API key configured."""
    monkeypatch.setenv("EIDOLON_GPU_API_KEY", api_key)

    # Reset the auth failure tracker between tests
    from src.auth import _failure_tracker
    _failure_tracker._buckets.clear()

    from src.main import app
    return TestClient(app)


@pytest.fixture
def client_no_auth(monkeypatch):
    """TestClient with NO API key configured."""
    monkeypatch.delenv("EIDOLON_GPU_API_KEY", raising=False)

    from src.auth import _failure_tracker
    _failure_tracker._buckets.clear()

    from src.main import app
    return TestClient(app)


@pytest.fixture
def auth_headers(api_key):
    """HTTP headers with valid API key."""
    return {"X-API-Key": api_key}

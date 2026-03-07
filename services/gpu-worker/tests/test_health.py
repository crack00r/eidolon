"""Tests for the health endpoint."""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture
def client():
    """Health endpoint does not require auth."""
    return TestClient(app)


class TestHealthEndpoint:
    """GET /health -- no auth required."""

    def test_health_returns_200(self, client):
        """Health check should return 200 even without API key."""
        response = client.get("/health")
        assert response.status_code == 200

    def test_health_response_structure(self, client):
        """Response must have status, uptime_seconds, gpu, models_loaded."""
        data = client.get("/health").json()
        assert "status" in data
        assert "uptime_seconds" in data
        assert "gpu" in data
        assert "models_loaded" in data

    def test_health_uptime_is_positive(self, client):
        """Uptime should be a positive number."""
        data = client.get("/health").json()
        assert data["uptime_seconds"] >= 0

    def test_health_gpu_structure(self, client):
        """GPU info must have 'available' boolean."""
        gpu = client.get("/health").json()["gpu"]
        assert isinstance(gpu["available"], bool)

    @patch("src.health.subprocess.run")
    def test_health_with_nvidia_smi_available(self, mock_run, client):
        """When nvidia-smi returns data, GPU info is populated."""
        mock_run.return_value = type("Result", (), {
            "returncode": 0,
            "stdout": "NVIDIA RTX 5080, 16384, 4096, 65, 42\n",
            "stderr": "",
        })()

        data = client.get("/health").json()
        gpu = data["gpu"]
        assert gpu["available"] is True
        assert gpu["name"] == "NVIDIA RTX 5080"
        assert gpu["vram_total_mb"] == 16384
        assert gpu["vram_used_mb"] == 4096
        assert gpu["temperature_c"] == 65
        assert gpu["utilization_pct"] == 42

    @patch("src.health.subprocess.run", side_effect=FileNotFoundError)
    def test_health_without_nvidia_smi(self, mock_run, client):
        """When nvidia-smi is not found, GPU is marked unavailable."""
        data = client.get("/health").json()
        assert data["gpu"]["available"] is False
        assert data["status"] == "degraded"

    @patch("src.health.subprocess.run")
    def test_health_nvidia_smi_non_zero_exit(self, mock_run, client):
        """When nvidia-smi returns non-zero, GPU is unavailable."""
        mock_run.return_value = type("Result", (), {
            "returncode": 1,
            "stdout": "",
            "stderr": "driver error",
        })()

        data = client.get("/health").json()
        assert data["gpu"]["available"] is False

    @patch("src.health.subprocess.run")
    def test_health_nvidia_smi_bad_output(self, mock_run, client):
        """When nvidia-smi output is unparseable, GPU is unavailable."""
        mock_run.return_value = type("Result", (), {
            "returncode": 0,
            "stdout": "garbled output\n",
            "stderr": "",
        })()

        data = client.get("/health").json()
        assert data["gpu"]["available"] is False

    def test_health_models_loaded_is_list(self, client):
        """models_loaded should be a list."""
        data = client.get("/health").json()
        assert isinstance(data["models_loaded"], list)

    def test_health_status_values(self, client):
        """Status should be one of healthy/degraded/unhealthy."""
        data = client.get("/health").json()
        assert data["status"] in ("healthy", "degraded", "unhealthy")

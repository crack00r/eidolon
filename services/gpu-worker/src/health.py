"""GPU health check endpoint."""

import logging
import subprocess
import time

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger("eidolon.gpu.health")


class GpuInfo(BaseModel):
    """GPU hardware information."""

    available: bool
    name: str | None = None
    vram_total_mb: int | None = None
    vram_used_mb: int | None = None
    temperature_c: int | None = None
    utilization_pct: int | None = None


class HealthResponse(BaseModel):
    """Health check response."""

    status: str  # "healthy", "degraded", "unhealthy"
    uptime_seconds: float
    gpu: GpuInfo
    models_loaded: list[str]


_start_time = time.time()
_loaded_models: list[str] = []
_last_gpu_status: bool | None = None


@router.get("")
async def health_check() -> HealthResponse:
    """Return service health including GPU status and loaded models."""
    global _last_gpu_status

    gpu = _get_gpu_info()
    status = "healthy" if gpu.available else "degraded"

    # Log GPU status changes
    if _last_gpu_status is not None and _last_gpu_status != gpu.available:
        if gpu.available:
            logger.info("GPU status changed: unavailable -> available")
        else:
            logger.warning("GPU status changed: available -> unavailable")
    _last_gpu_status = gpu.available

    return HealthResponse(
        status=status,
        uptime_seconds=time.time() - _start_time,
        gpu=gpu,
        models_loaded=_loaded_models,
    )


def _get_gpu_info() -> GpuInfo:
    """Query GPU info via nvidia-smi. Returns unavailable on failure."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.used,temperature.gpu,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            logger.warning(
                "nvidia-smi returned non-zero exit code %d: %s",
                result.returncode,
                result.stderr.strip() or "(no stderr)",
            )
            return GpuInfo(available=False)

        parts = result.stdout.strip().split(", ")
        return GpuInfo(
            available=True,
            name=parts[0],
            vram_total_mb=int(parts[1]),
            vram_used_mb=int(parts[2]),
            temperature_c=int(parts[3]),
            utilization_pct=int(parts[4]),
        )
    except FileNotFoundError:
        logger.debug("nvidia-smi not found — GPU monitoring unavailable")
        return GpuInfo(available=False)
    except subprocess.TimeoutExpired:
        logger.error("nvidia-smi timed out after 5 seconds")
        return GpuInfo(available=False)
    except (IndexError, ValueError) as exc:
        logger.error("Failed to parse nvidia-smi output: %s", exc)
        return GpuInfo(available=False)

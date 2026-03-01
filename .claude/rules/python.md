---
paths:
  - "services/gpu-worker/**/*.py"
---

# Python Conventions (GPU Worker)

## Stack

- Python 3.12+, FastAPI, uvicorn.
- `uv` for dependency management (pyproject.toml).
- Type hints on all function signatures (PEP 484).
- Pydantic v2 models for all request/response validation.

## GPU Worker Specifics

- **STT**: faster-whisper (CTranslate2 backend). Float16 on GPU, int8 on CPU fallback.
- **TTS**: Qwen3-TTS 1.7B primary, Kitten TTS CPU fallback.
- All endpoints require pre-shared key in `X-Auth-Token` header.
- Health check endpoint at `GET /health` (no auth required).

## Code Style

- snake_case for functions, variables, modules.
- PascalCase for classes and Pydantic models.
- UPPER_SNAKE_CASE for constants.
- Use `async def` for all FastAPI route handlers.
- Use `logging` module with structured JSON output, not print statements.

## Error Handling

- Return proper HTTP status codes (400 for validation, 503 for GPU unavailable).
- Never expose internal errors to clients. Log full traceback, return sanitized message.
- Graceful degradation: if GPU OOM, return 503 with retry-after header.

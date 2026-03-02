"""WebSocket real-time voice endpoint.

Endpoint: WS /voice/realtime
Protocol: Opus frames (binary) in, Opus frames (binary) + JSON text out
State machine: idle -> listening -> processing -> speaking -> interrupted

Authentication: query parameter ``token`` validated against EIDOLON_GPU_API_KEY.

SECURITY NOTE: The auth token is passed as a query parameter because the WebSocket
protocol does not support custom headers during the handshake in browser contexts.
This means the token may appear in server access logs, browser history, and proxy logs.
This is a known limitation of WebSocket authentication. To mitigate:
  - Use TLS (wss://) to prevent network sniffing.
  - Ensure server access logs are protected and rotated.
  - Consider short-lived tokens where possible.
"""

import asyncio
import hmac
import json
import logging
import math
import os
import struct
import time
from enum import Enum
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

router = APIRouter()
logger = logging.getLogger("eidolon.gpu.voice_ws")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Energy-based VAD threshold (RMS of 16-bit PCM samples)
VAD_ENERGY_THRESHOLD = 500.0

# Number of consecutive silent frames before considering speech ended
VAD_SILENCE_FRAMES = 15  # ~750ms at 20ms per Opus frame (50fps)

# Maximum audio buffer size before forced transcription (10 seconds at ~32kbps)
MAX_AUDIO_BUFFER_BYTES = 40_000

# Keep-alive interval: client should ping within this window
KEEPALIVE_TIMEOUT_SECONDS = 60

# Maximum text length for TTS requests via WebSocket
MAX_WS_TTS_TEXT_LENGTH = 10_000


class VoiceState(str, Enum):
    """Voice session state machine."""

    IDLE = "idle"
    LISTENING = "listening"
    PROCESSING = "processing"
    SPEAKING = "speaking"
    INTERRUPTED = "interrupted"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _validate_token(token: Optional[str]) -> bool:
    """Validate the provided token against the configured API key."""
    api_key = os.environ.get("EIDOLON_GPU_API_KEY", "").strip()
    if not api_key:
        return False
    if not token or not token.strip():
        return False
    return hmac.compare_digest(token.strip(), api_key)


def _compute_rms_energy(opus_data: bytes) -> float:
    """Compute RMS energy from raw audio data.

    For a real implementation, the Opus data would be decoded to PCM first.
    This stub treats the raw bytes as approximate energy indicators by
    interpreting them as signed 16-bit samples when possible, or falling
    back to byte-level energy estimation.
    """
    if len(opus_data) < 2:
        return 0.0

    # Try to interpret as 16-bit signed PCM samples
    num_samples = len(opus_data) // 2
    if num_samples == 0:
        return 0.0

    try:
        samples = struct.unpack(f"<{num_samples}h", opus_data[: num_samples * 2])
        sum_sq = sum(s * s for s in samples)
        return math.sqrt(sum_sq / num_samples)
    except struct.error:
        # Fallback: byte-level energy
        sum_sq = sum((b - 128) ** 2 for b in opus_data)
        return math.sqrt(sum_sq / len(opus_data))


async def _send_json(ws: WebSocket, data: dict) -> bool:
    """Send a JSON message over WebSocket. Returns False if connection is closed."""
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_text(json.dumps(data))
            return True
    except (WebSocketDisconnect, RuntimeError):
        pass
    return False


async def _send_binary(ws: WebSocket, data: bytes) -> bool:
    """Send binary data over WebSocket. Returns False if connection is closed."""
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_bytes(data)
            return True
    except (WebSocketDisconnect, RuntimeError):
        pass
    return False


async def _send_state(ws: WebSocket, state: VoiceState) -> bool:
    """Send state update to the client."""
    return await _send_json(ws, {"type": "state", "state": state.value})


async def _send_error(ws: WebSocket, message: str) -> bool:
    """Send error message to the client."""
    return await _send_json(ws, {"type": "error", "message": message})


# ---------------------------------------------------------------------------
# Transcription stub
# ---------------------------------------------------------------------------


async def _transcribe_audio(audio_buffer: bytes) -> dict:
    """Transcribe buffered audio using faster-whisper.

    Stub implementation: returns a placeholder. When faster-whisper is loaded,
    this will decode Opus -> PCM and run inference.
    """
    # In production, this would:
    # 1. Decode Opus frames to PCM using opuslib or similar
    # 2. Run faster-whisper model.transcribe() on the PCM data
    # 3. Return the transcription result

    logger.info(
        "STT transcription requested — model not loaded (buffer_size=%d bytes)",
        len(audio_buffer),
    )

    return {
        "text": "",
        "language": "en",
        "confidence": 0.0,
        "is_final": True,
        "model_loaded": False,
    }


# ---------------------------------------------------------------------------
# TTS stub
# ---------------------------------------------------------------------------


async def _synthesize_speech(text: str, voice: str = "default") -> Optional[bytes]:
    """Synthesize text to Opus audio.

    Stub implementation: returns None. When Qwen3-TTS is loaded,
    this will generate audio and encode to Opus.
    """
    logger.info(
        "TTS synthesis requested — model not loaded (text_length=%d, voice=%s)",
        len(text),
        voice,
    )

    return None


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


@router.websocket("/realtime")
async def voice_realtime(ws: WebSocket, token: str = ""):
    """Real-time bidirectional voice WebSocket endpoint.

    Authentication via query parameter: ws://host/voice/realtime?token=<api_key>

    Binary frames: Opus-encoded audio chunks (client -> server for STT)
    Text frames: JSON messages for control and TTS requests

    Client -> Server text messages:
        { "type": "ping" }
        { "type": "tts", "text": "...", "voice": "..." }
        { "type": "control", "action": "start" | "stop" | "interrupt" }

    Server -> Client text messages:
        { "type": "transcript", "text": "...", "final": true|false }
        { "type": "state", "state": "idle"|"listening"|"processing"|"speaking"|"interrupted" }
        { "type": "error", "message": "..." }
        { "type": "pong" }

    Server -> Client binary messages:
        Opus-encoded audio chunks (TTS output)
    """
    # ---- Security: warn about token in URL ----
    if token:
        logger.warning(
            "Auth token provided via query parameter — token visible in server logs and browser history"
        )

    # ---- Security: reject if token leaks via Referer header ----
    referer = ws.headers.get("referer", "") or ""
    if token and token in referer:
        logger.warning(
            "Rejecting WebSocket — auth token found in Referer header (token leak risk)"
        )
        await ws.close(code=4003, reason="Token detected in Referer header")
        return

    # ---- Authentication ----
    if not _validate_token(token):
        logger.warning("WebSocket auth failure — invalid or missing token")
        await ws.close(code=4001, reason="Invalid or missing token")
        return

    # ---- Accept connection ----
    await ws.accept()
    logger.info("WebSocket voice session connected")

    state = VoiceState.IDLE
    audio_buffer = bytearray()
    silence_frame_count = 0
    last_activity = time.monotonic()
    tts_task: Optional[asyncio.Task] = None

    try:
        await _send_state(ws, state)

        while True:
            # Check keepalive timeout
            if time.monotonic() - last_activity > KEEPALIVE_TIMEOUT_SECONDS:
                logger.warning("WebSocket keepalive timeout — closing")
                await _send_error(ws, "Keepalive timeout")
                break

            try:
                # Wait for next message with timeout
                message = await asyncio.wait_for(
                    ws.receive(),
                    timeout=KEEPALIVE_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                logger.warning("WebSocket receive timeout — closing")
                await _send_error(ws, "Receive timeout")
                break

            last_activity = time.monotonic()
            msg_type = message.get("type", "")

            # ---- Connection closed ----
            if msg_type == "websocket.disconnect":
                logger.info("WebSocket client disconnected")
                break

            # ---- Binary frame: audio data ----
            if msg_type == "websocket.receive" and "bytes" in message and message["bytes"]:
                audio_data = message["bytes"]
                energy = _compute_rms_energy(audio_data)

                if energy > VAD_ENERGY_THRESHOLD:
                    # Speech detected
                    silence_frame_count = 0

                    if state == VoiceState.IDLE:
                        state = VoiceState.LISTENING
                        await _send_state(ws, state)
                        logger.debug("VAD: speech start detected (energy=%.1f)", energy)

                    if state == VoiceState.SPEAKING:
                        # User interrupted TTS playback
                        state = VoiceState.INTERRUPTED
                        await _send_state(ws, state)
                        logger.info("User interrupted TTS playback")
                        # Cancel ongoing TTS
                        if tts_task and not tts_task.done():
                            tts_task.cancel()
                        # Reset to listening
                        state = VoiceState.LISTENING
                        await _send_state(ws, state)
                        audio_buffer.clear()

                    audio_buffer.extend(audio_data)
                else:
                    # Silence
                    if state == VoiceState.LISTENING:
                        silence_frame_count += 1
                        # Still append audio during silence gap
                        audio_buffer.extend(audio_data)

                        if silence_frame_count >= VAD_SILENCE_FRAMES:
                            # Speech ended — transcribe
                            logger.debug(
                                "VAD: speech end detected (silence_frames=%d, buffer=%d bytes)",
                                silence_frame_count,
                                len(audio_buffer),
                            )
                            state = VoiceState.PROCESSING
                            await _send_state(ws, state)

                            # Run transcription
                            result = await _transcribe_audio(bytes(audio_buffer))
                            audio_buffer.clear()
                            silence_frame_count = 0

                            # Send transcription result
                            await _send_json(
                                ws,
                                {
                                    "type": "transcript",
                                    "text": result["text"],
                                    "final": result["is_final"],
                                },
                            )

                            state = VoiceState.IDLE
                            await _send_state(ws, state)

                # Force transcription if buffer is too large
                if len(audio_buffer) > MAX_AUDIO_BUFFER_BYTES and state == VoiceState.LISTENING:
                    logger.info(
                        "Audio buffer exceeded max size (%d bytes) — forcing transcription",
                        len(audio_buffer),
                    )
                    state = VoiceState.PROCESSING
                    await _send_state(ws, state)

                    result = await _transcribe_audio(bytes(audio_buffer))
                    audio_buffer.clear()
                    silence_frame_count = 0

                    await _send_json(
                        ws,
                        {
                            "type": "transcript",
                            "text": result["text"],
                            "final": False,  # Forced cut, may not be final
                        },
                    )

                    state = VoiceState.LISTENING
                    await _send_state(ws, state)

                continue

            # ---- Text frame: JSON command ----
            if msg_type == "websocket.receive" and "text" in message and message["text"]:
                raw_text = message["text"]
                try:
                    payload = json.loads(raw_text)
                except (json.JSONDecodeError, ValueError):
                    await _send_error(ws, "Invalid JSON")
                    continue

                if not isinstance(payload, dict):
                    await _send_error(ws, "Expected JSON object")
                    continue

                cmd_type = payload.get("type", "")

                # ---- Ping/Pong ----
                if cmd_type == "ping":
                    await _send_json(ws, {"type": "pong"})
                    continue

                # ---- TTS request ----
                if cmd_type == "tts":
                    tts_text = payload.get("text", "")
                    tts_voice = payload.get("voice", "default")

                    if not tts_text or not isinstance(tts_text, str):
                        await _send_error(ws, "TTS text is required and must be a string")
                        continue

                    if len(tts_text) > MAX_WS_TTS_TEXT_LENGTH:
                        await _send_error(
                            ws,
                            f"TTS text too long: {len(tts_text)} chars (max {MAX_WS_TTS_TEXT_LENGTH})",
                        )
                        continue

                    if not isinstance(tts_voice, str):
                        tts_voice = "default"

                    logger.info(
                        "TTS request received (text_length=%d, voice=%s)",
                        len(tts_text),
                        tts_voice,
                    )

                    state = VoiceState.SPEAKING
                    await _send_state(ws, state)

                    # Synthesize and stream audio back
                    audio_result = await _synthesize_speech(tts_text, tts_voice)
                    if audio_result is not None:
                        # Stream audio in chunks
                        chunk_size = 4096
                        for i in range(0, len(audio_result), chunk_size):
                            if state == VoiceState.INTERRUPTED:
                                logger.info("TTS streaming interrupted")
                                break
                            chunk = audio_result[i : i + chunk_size]
                            await _send_binary(ws, chunk)
                    else:
                        await _send_error(ws, "TTS model not loaded")

                    if state != VoiceState.INTERRUPTED:
                        state = VoiceState.IDLE
                        await _send_state(ws, state)

                    continue

                # ---- Control messages ----
                if cmd_type == "control":
                    action = payload.get("action", "")

                    if action == "interrupt":
                        logger.info("Client requested interrupt")
                        state = VoiceState.INTERRUPTED
                        await _send_state(ws, state)
                        if tts_task and not tts_task.done():
                            tts_task.cancel()
                        audio_buffer.clear()
                        silence_frame_count = 0
                        state = VoiceState.IDLE
                        await _send_state(ws, state)

                    elif action == "start":
                        logger.debug("Client requested start listening")
                        state = VoiceState.LISTENING
                        audio_buffer.clear()
                        silence_frame_count = 0
                        await _send_state(ws, state)

                    elif action == "stop":
                        logger.debug("Client requested stop listening")
                        if audio_buffer:
                            state = VoiceState.PROCESSING
                            await _send_state(ws, state)
                            result = await _transcribe_audio(bytes(audio_buffer))
                            audio_buffer.clear()
                            silence_frame_count = 0
                            await _send_json(
                                ws,
                                {
                                    "type": "transcript",
                                    "text": result["text"],
                                    "final": True,
                                },
                            )
                        state = VoiceState.IDLE
                        await _send_state(ws, state)

                    else:
                        await _send_error(ws, f"Unknown control action: {action}")

                    continue

                await _send_error(ws, f"Unknown message type: {cmd_type}")
                continue

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception:
        logger.exception("WebSocket error")
        try:
            await _send_error(ws, "Internal server error")
        except Exception:
            pass
    finally:
        # Cleanup
        if tts_task and not tts_task.done():
            tts_task.cancel()
        audio_buffer.clear()
        logger.info("WebSocket voice session cleaned up")

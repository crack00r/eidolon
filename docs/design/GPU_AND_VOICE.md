# GPU Offloading & Voice

## Architecture

Eidolon separates the brain (Core daemon on Ubuntu server) from compute-intensive workloads (GPU worker on Windows PC). They communicate over the Tailscale mesh network.

```
Ubuntu Server                         Windows PC (RTX 5080)
┌──────────────────┐                 ┌──────────────────────┐
│ Eidolon Core     │                 │ GPU Worker            │
│                  │    Tailscale    │                      │
│  GPU Manager ────┼────────────────►│ FastAPI Server        │
│  TTS Client      │    HTTP/gRPC   │  Port 8420            │
│  STT Client      │                │                      │
│                  │                │ ┌──────────────────┐  │
│  "Say: Hello"    │                │ │ Qwen3-TTS        │  │
│                  │◄───────────────│ │ 1.7B-CustomVoice │  │
│  Audio Stream    │   Audio Bytes  │ │ bfloat16          │  │
│                  │                │ │ ~3.4GB VRAM       │  │
│                  │                │ └──────────────────┘  │
│                  │                │                      │
│                  │                │ ┌──────────────────┐  │
│                  │                │ │ Whisper Large v3 │  │
│                  │◄───────────────│ │ STT              │  │
│                  │   Text         │ │ ~3GB VRAM        │  │
│                  │                │ └──────────────────┘  │
└──────────────────┘                └──────────────────────┘
```

## GPU Worker Service

### Technology Stack

| Component | Technology | Rationale |
|---|---|---|
| API Framework | FastAPI | Async Python, OpenAPI docs, streaming support |
| TTS Engine | Qwen3-TTS | Open source, 10 languages, voice clone, streaming |
| STT Engine | Whisper Large v3 | Best open-source STT, multilingual |
| Model Serving | Direct Python or vLLM | Direct for simplicity, vLLM for performance |
| Containerization | Docker (NVIDIA Container Toolkit) | Reproducible GPU environment |

### API Endpoints

```
POST /tts/generate
  Body: { text, language, speaker, instruct? }
  Response: Audio bytes (WAV)

POST /tts/stream
  Body: { text, language, speaker, instruct? }
  Response: Server-Sent Events with audio chunks

POST /tts/clone
  Body: { text, language, ref_audio (base64), ref_text }
  Response: Audio bytes (WAV)

POST /stt/transcribe
  Body: Multipart form with audio file
  Response: { text, language, confidence, segments[] }

GET /health
  Response: {
    status: "ok",
    gpu: { name, vram_total, vram_used, temperature, utilization },
    models: { tts: { loaded, model }, stt: { loaded, model } }
  }

WS /voice/realtime
  Bidirectional WebSocket for real-time voice conversation
  Client sends: audio chunks (PCM 16kHz)
  Server sends: audio chunks (PCM 24kHz) + text transcription
```

### Qwen3-TTS Details

**Model choice:** `Qwen3-TTS-12Hz-1.7B-CustomVoice`

Rationale:
- 1.7B parameters, fits comfortably on RTX 5080 (16GB VRAM) in bfloat16 (~3.4GB)
- CustomVoice variant supports 9 premium voices + instruction control
- 10 languages: Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian
- Streaming generation with ~97ms first-packet latency
- 12Hz token rate = efficient compression

**Available speakers:**
| Speaker | Description | Native Language |
|---|---|---|
| Vivian | Bright, slightly edgy young female | Chinese |
| Serena | Warm, gentle young female | Chinese |
| Uncle_Fu | Seasoned male, low mellow timbre | Chinese |
| Dylan | Youthful Beijing male, clear natural | Chinese (Beijing) |
| Eric | Lively Chengdu male, slightly husky | Chinese (Sichuan) |
| Ryan | Dynamic male with rhythmic drive | English |
| Aiden | Sunny American male, clear midrange | English |
| Ono_Anna | Playful Japanese female, light nimble | Japanese |
| Sohee | Warm Korean female, rich emotion | Korean |

### GPU Memory Budget (RTX 5080 16GB)

| Model | VRAM (bfloat16) | Notes |
|---|---|---|
| Qwen3-TTS 1.7B | ~3.4 GB | Always loaded |
| Whisper Large v3 | ~3.0 GB | Loaded on demand |
| **Total** | **~6.4 GB** | 9.6 GB free for other tasks |

With FlashAttention2, memory usage is further reduced.

## Voice Conversation Flow

### Text-to-Speech (Response)

```
1. Core receives text response from Claude Code
2. Core sends text to GPU Worker TTS endpoint
3. GPU Worker generates audio with Qwen3-TTS
4. Audio is streamed back to Core
5. Core routes audio to requesting client:
   - Desktop: Played through system speakers
   - iOS: Played through device speakers
   - Telegram: Sent as voice message
```

### Speech-to-Text (Input)

```
1. Client captures audio (microphone)
2. Audio is sent to Core via WebSocket
3. Core forwards audio to GPU Worker STT endpoint
4. Whisper transcribes audio to text
5. Text is fed into the Cognitive Loop as a regular message
```

### Real-Time Voice Chat

For low-latency bidirectional voice:

```
Client                    Core                     GPU Worker
  │                        │                         │
  │─ audio chunk ────────>│                         │
  │                        │─ audio chunk ─────────>│
  │                        │                         │─ STT
  │                        │<─ transcription ───────│
  │                        │                         │
  │                        │─ text to Claude Code ──>│
  │                        │<─ response text ────────│
  │                        │                         │
  │                        │─ text for TTS ────────>│
  │                        │                         │─ TTS
  │                        │<─ audio chunks ────────│
  │<─ audio chunks ───────│                         │
  │                        │                         │
```

Total latency target: < 2 seconds end-to-end
- STT: ~500ms (Whisper with chunked processing)
- Claude response: ~500-1000ms (first token)
- TTS: ~97ms (first audio packet with streaming)

## GPU Worker Setup

### Docker Deployment

```dockerfile
# Dockerfile.cuda
FROM nvidia/cuda:12.4-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y python3.12 python3-pip

COPY requirements.txt .
RUN pip install -r requirements.txt
RUN pip install flash-attn --no-build-isolation

COPY src/ /app/src/
WORKDIR /app

# Pre-download models on build
RUN python3 -c "from qwen_tts import Qwen3TTSModel; Qwen3TTSModel.from_pretrained('Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice')"

EXPOSE 8420
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8420"]
```

### Docker Compose

```yaml
# docker-compose.gpu.yml (runs on Windows PC)
services:
  gpu-worker:
    build:
      context: services/gpu-worker
      dockerfile: Dockerfile.cuda
    ports:
      - "8420:8420"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    environment:
      - CUDA_VISIBLE_DEVICES=0
    volumes:
      - gpu-worker-models:/root/.cache/huggingface
    restart: unless-stopped

volumes:
  gpu-worker-models:
```

### Native Deployment (Alternative)

For those who prefer running directly:

```bash
# On Windows PC with CUDA
conda create -n eidolon-gpu python=3.12 -y
conda activate eidolon-gpu

pip install qwen-tts
pip install flash-attn --no-build-isolation
pip install fastapi uvicorn openai-whisper

# Start the GPU worker
python -m src.main --port 8420
```

## GPU Discovery

The Core daemon discovers GPU workers on the Tailscale network.

### Manual Configuration

```jsonc
{
  "gpu": {
    "workers": [
      {
        "name": "windows-5080",
        "host": "windows-pc.tailnet.ts.net",  // Tailscale hostname
        "port": 8420,
        "capabilities": ["tts", "stt"],
        "healthCheckInterval": "30s"
      }
    ]
  }
}
```

### Health Monitoring

The GPU Manager periodically checks worker health:

```typescript
class GPUManager {
  private workers: GPUWorker[];

  async healthCheck(): Promise<void> {
    for (const worker of this.workers) {
      try {
        const health = await fetch(`http://${worker.host}:${worker.port}/health`);
        worker.status = 'online';
        worker.gpuInfo = await health.json();
      } catch {
        worker.status = 'offline';
      }
    }
  }

  getAvailableWorker(capability: 'tts' | 'stt'): GPUWorker | null {
    return this.workers.find(w =>
      w.status === 'online' &&
      w.capabilities.includes(capability)
    ) || null;
  }
}
```

## Voice Mode UX

### Desktop Client

- Push-to-talk (configurable hotkey)
- Always-on listening (wake word detection, optional)
- Visual indicator showing voice activity
- Audio level meters for input/output

### iOS App

- Push-to-talk button
- Siri Shortcut integration ("Hey Siri, ask Eidolon...")
- Background audio playback for responses

### Telegram

- Voice messages are automatically transcribed via Whisper
- Text responses can optionally be sent as voice messages (TTS)
- Voice-only mode: all responses are voice messages

## Fallback Strategy

If the GPU worker is unavailable:

1. **TTS fallback:** Use system TTS (macOS `say`, Windows SAPI, Linux espeak). Lower quality but functional.
2. **STT fallback:** Use Whisper.cpp on CPU (slower but works without GPU).
3. **No voice fallback:** Text-only mode. All interactions via text.

The system never blocks on voice. If GPU is offline, it degrades gracefully to text.

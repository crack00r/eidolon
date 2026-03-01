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

## Real-Time Voice Protocol ("Her"-Style)

The basic voice flow above is half-duplex: speak, wait, listen. For a truly natural conversational experience — like the film *Her* — Eidolon supports **full-duplex streaming voice** with interruption handling, echo cancellation, and sentence-level TTS chunking for minimal perceived latency.

### Design Goals

| Goal | Target |
|---|---|
| End-to-end latency (silence → first audio response) | < 900ms |
| Interruption response time | < 200ms |
| Concurrent speak + listen | Yes (full-duplex) |
| Wake word support | Optional ("Hey Eidolon") |
| Supported modes | Push-to-talk, always-listening, wake-word |

### Latency Budget

```
User stops speaking
  │
  ├─ VAD endpointing ──────────── 200-300ms
  │   (detect end of speech)
  │
  ├─ STT (streaming Whisper) ──── 100-200ms
  │   (final transcription)
  │
  ├─ Claude first token ───────── 300-500ms
  │   (thinking + generation)
  │
  ├─ Sentence buffer ──────────── 50-100ms
  │   (accumulate first sentence)
  │
  └─ TTS first packet ─────────── 97ms
      (Qwen3-TTS streaming)

Total: ~750-1200ms (target median: ~900ms)
```

### WebSocket Protocol Specification

The `WS /voice/realtime` endpoint uses a binary+JSON protocol:

```typescript
// Client → Server messages
type ClientMessage =
  | { type: 'audio'; data: ArrayBuffer }        // PCM 16-bit, 16kHz mono
  | { type: 'control'; action: 'start' | 'stop' | 'interrupt' }
  | { type: 'config'; vad: VADConfig; mode: 'push-to-talk' | 'always-on' | 'wake-word' }

// Server → Client messages
type ServerMessage =
  | { type: 'audio'; data: ArrayBuffer }        // PCM 16-bit, 24kHz mono
  | { type: 'transcript'; text: string; final: boolean }  // STT result
  | { type: 'response_text'; text: string; done: boolean } // Claude's text
  | { type: 'state'; state: VoiceState }        // State machine update
  | { type: 'error'; message: string }

type VoiceState =
  | 'idle'            // Waiting for user speech
  | 'listening'       // VAD detected speech, recording
  | 'processing'      // STT + Claude thinking
  | 'speaking'        // TTS playing back
  | 'interrupted'     // User interrupted, canceling playback
```

### Voice State Machine

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    ▼                                         │
              ┌──────────┐                                    │
         ┌───>│   IDLE   │<───────────────────────┐           │
         │    └────┬─────┘                        │           │
         │         │ VAD: speech start             │           │
         │         ▼                               │           │
         │    ┌──────────┐                        │           │
         │    │LISTENING │                        │           │
         │    └────┬─────┘                        │           │
         │         │ VAD: speech end               │           │
         │         ▼                               │           │
         │    ┌────────────┐                      │           │
         │    │PROCESSING  │─── timeout ──────────┘           │
         │    └────┬───────┘                                  │
         │         │ first TTS chunk ready                    │
         │         ▼                                          │
         │    ┌──────────┐    user speaks                     │
         │    │ SPEAKING │────────────────>┌─────────────┐    │
         │    └────┬─────┘                │ INTERRUPTED  │────┘
         │         │ TTS complete          └─────────────┘
         │         │                       cancel TTS queue
         └─────────┘                       flush audio buffers
```

### Sentence-Level TTS Chunking

Instead of waiting for Claude's full response before starting TTS, Eidolon chunks the streaming text into sentences and dispatches each to TTS independently:

```typescript
class StreamingVoicePipeline {
  private sentenceBuffer = '';
  private ttsQueue: Promise<void>[] = [];

  // Called for each token from Claude's streaming response
  async onToken(token: string): Promise<void> {
    this.sentenceBuffer += token;

    // Check for sentence boundaries
    const sentenceEnd = /[.!?]\s|[.!?]$|\n/;
    if (sentenceEnd.test(this.sentenceBuffer) && this.sentenceBuffer.length > 10) {
      const sentence = this.sentenceBuffer.trim();
      this.sentenceBuffer = '';

      // Dispatch sentence to TTS immediately — don't wait for previous to finish
      this.ttsQueue.push(this.speakSentence(sentence));
    }
  }

  private async speakSentence(sentence: string): Promise<void> {
    // Wait for previous sentence to start playing (not finish)
    // This ensures sentences play in order
    await this.waitForPreviousStart();

    // Stream TTS for this sentence
    const audioStream = await this.gpu.ttsStream({
      text: sentence,
      language: this.language,
      speaker: this.speaker,
    });

    // Stream audio chunks to client as they arrive
    for await (const chunk of audioStream) {
      if (this.interrupted) {
        audioStream.cancel();
        return;
      }
      this.sendAudioToClient(chunk);
    }
  }

  // Handle user interruption (barge-in)
  async onInterrupt(): Promise<void> {
    this.interrupted = true;

    // 1. Cancel all pending TTS requests
    for (const pending of this.ttsQueue) {
      // TTS requests check this.interrupted flag
    }
    this.ttsQueue = [];

    // 2. Flush audio output buffer
    this.sendControl({ type: 'control', action: 'flush_audio' });

    // 3. Reset state
    this.sentenceBuffer = '';
    this.interrupted = false;

    // 4. Transition to LISTENING for new input
    this.setState('listening');
  }
}
```

**Effect:** The user hears the first sentence of the response ~900ms after they stop speaking, while Claude is still generating the rest. Subsequent sentences play back-to-back with no gap.

### Voice Activity Detection (VAD)

VAD runs **client-side** to minimize latency. The client only sends audio to the server when speech is detected.

**Recommended implementations:**
| Platform | VAD Solution | Size |
|---|---|---|
| Desktop (Tauri) | [Silero VAD](https://github.com/snakers4/silero-vad) via ONNX Runtime | ~2MB |
| iOS | Apple Speech framework (built-in) | 0 |
| Web | WebRTC VAD or Silero VAD (WASM) | ~1MB |

**Configuration:**
```typescript
interface VADConfig {
  threshold: number;           // Speech probability threshold (default: 0.5)
  minSpeechDuration: number;   // Minimum speech to trigger (default: 250ms)
  maxSpeechDuration: number;   // Max recording length (default: 30s)
  silenceDuration: number;     // Silence to end speech (default: 300ms — the "endpointing" delay)
  prefixPadding: number;       // Audio to keep before VAD trigger (default: 100ms)
}
```

**Endpointing strategy:** The `silenceDuration` parameter controls how quickly Eidolon decides the user has finished speaking. Too short (100ms) and it cuts off mid-pause. Too long (500ms) and the response feels slow. The default 300ms is a good balance. Users can adjust via config.

### Barge-In / Interruption Handling

When the user starts speaking while Eidolon is talking:

```
1. Client-side VAD detects new speech during SPEAKING state
2. Client sends { type: 'control', action: 'interrupt' }
3. Server immediately:
   a. Cancels the current Claude Code session (or lets it finish in background)
   b. Cancels all pending TTS requests to GPU worker
   c. Sends { type: 'control', action: 'flush_audio' } to client
4. Client immediately:
   a. Stops playing audio output
   b. Clears audio output buffer
   c. Starts capturing new user speech
5. Server transitions to LISTENING state
6. New user speech is processed as a fresh turn (with conversation context preserved)
```

**Partial response handling:** When interrupted, the text Claude had generated so far is kept in conversation context (marked as interrupted). This means if the user says "wait, go back" — Eidolon knows what it was saying.

### Echo Cancellation

The system must prevent Eidolon from "hearing" its own voice output through the user's microphone. Two strategies:

**Strategy 1: Hardware AEC (Recommended for Desktop)**
- Use the platform's built-in acoustic echo cancellation:
  - macOS: Core Audio AEC
  - Windows: Windows Audio Session API (WASAPI) with AEC DSP
  - Linux: PulseAudio echo cancellation module
- This is handled at the OS level, transparent to Eidolon

**Strategy 2: Software VAD Gating (Recommended for simple setups)**
- During SPEAKING state, raise the VAD threshold significantly (0.5 → 0.85)
- Only trigger barge-in if the speech probability is very high (real human speech, not echo)
- Simpler but may miss quiet interruptions

**Strategy 3: Ducking (Fallback)**
- Reduce microphone gain to 0 while audio is playing
- Re-enable mic 50ms after playback stops
- Simplest but prevents true simultaneous duplex

**Configuration:**
```jsonc
{
  "voice": {
    "echoCancellation": "hardware",  // 'hardware' | 'vad-gating' | 'ducking'
    "bargeIn": true,                 // Allow interruptions
    "vadThresholdSpeaking": 0.85,    // Higher threshold during playback (for vad-gating)
    "vadThresholdListening": 0.5     // Normal threshold
  }
}
```

### Platform-Specific Voice UX

**Desktop (Tauri):**
- System tray icon changes color based on voice state (idle/listening/speaking)
- Global hotkey for push-to-talk (default: `Ctrl+Space`)
- Always-on mode with Silero VAD + optional wake word
- Audio routing: system default output device, configurable input device
- Waveform visualization during speech

**iOS (SwiftUI):**
- `AVAudioSession` with `.playAndRecord` category for full-duplex
- Built-in AEC via `AVAudioSession.Mode.voiceChat`
- Background audio with `UIBackgroundModes: [audio]`
- Haptic feedback on state transitions
- Siri Shortcut as alternative wake mechanism

**Telegram:**
- No real-time streaming (Telegram API limitation)
- Voice messages transcribed on receive → response generated → TTS → sent as voice message
- Round-trip latency: 3-5 seconds (acceptable for async voice)

### GPU Worker Streaming Endpoint

The `/voice/realtime` WebSocket on the GPU worker handles the bidirectional audio stream:

```python
@app.websocket("/voice/realtime")
async def voice_realtime(ws: WebSocket):
    await ws.accept()
    stt_buffer = AudioBuffer(sample_rate=16000)
    tts_task: Optional[asyncio.Task] = None

    async for message in ws.iter_json():
        if message["type"] == "audio":
            # Accumulate audio for STT
            audio_data = base64.b64decode(message["data"])
            stt_buffer.append(audio_data)

        elif message["type"] == "transcribe":
            # Run STT on accumulated audio
            text = await whisper_transcribe(stt_buffer.get_audio())
            stt_buffer.clear()
            await ws.send_json({
                "type": "transcript",
                "text": text,
                "final": True,
            })

        elif message["type"] == "tts_stream":
            # Stream TTS for a sentence
            async def stream_tts():
                async for chunk in qwen_tts_stream(
                    text=message["text"],
                    speaker=message.get("speaker", "Aiden"),
                    language=message.get("language", "en"),
                ):
                    await ws.send_bytes(chunk)
                await ws.send_json({"type": "tts_done"})

            tts_task = asyncio.create_task(stream_tts())

        elif message["type"] == "cancel_tts":
            if tts_task and not tts_task.done():
                tts_task.cancel()
                await ws.send_json({"type": "tts_cancelled"})
```

### Monitoring & Metrics

Voice quality metrics tracked per session:
- **Latency P50/P95**: end-to-end time from silence to first audio
- **Interruption rate**: how often the user interrupts (high = talking too much)
- **STT accuracy**: word error rate (if reference available)
- **Session duration**: total voice conversation time
- **Fallback events**: how often TTS fell back to lower-quality tier

```sql
CREATE TABLE voice_metrics (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    latency_ms INTEGER,           -- End-to-end latency
    stt_duration_ms INTEGER,      -- STT processing time
    tts_duration_ms INTEGER,      -- TTS generation time
    interrupted BOOLEAN,          -- Was this turn interrupted?
    tts_tier TEXT,                -- 'qwen3' | 'kitten' | 'system'
    created_at TEXT NOT NULL
);
```

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

If the GPU worker is unavailable, Eidolon degrades gracefully through multiple fallback tiers:

### TTS Fallback Chain

```
Tier 1: Qwen3-TTS on GPU Worker (RTX 5080)
  ↓ GPU offline
Tier 2: Kitten TTS on CPU (any device)
  ↓ Not installed
Tier 3: System TTS (macOS 'say', Windows SAPI, Linux espeak)
  ↓ Not available
Tier 4: Text-only mode
```

### Kitten TTS (CPU Fallback)

[Kitten TTS](https://github.com/kit-tts/kitten-tts) is a ~25MB model (14M parameters) that runs on CPU with near-real-time performance. It provides a middle ground between GPU-quality Qwen3-TTS and robotic system TTS.

| Aspect | Qwen3-TTS (GPU) | Kitten TTS (CPU) | System TTS |
|---|---|---|---|
| Quality | Excellent | Good | Basic |
| Size | ~3.4 GB VRAM | ~25 MB RAM | 0 (built-in) |
| Hardware | GPU required | Any CPU | Any |
| Latency | ~97ms (streaming) | ~200ms (batch) | ~50ms |
| Languages | 10 | 8 | Varies |
| Voices | 9 premium | 8 expressive | 1-3 |

Kitten TTS is particularly useful for:
- MacBook/iPhone when away from home (no GPU access)
- Fallback when Windows PC is off or GPU worker is down
- Quick responses where latency matters more than quality

### Configuration

```jsonc
{
  "gpu": {
    "fallback": {
      "tts": "kitten",              // 'kitten' | 'system' | 'text-only'
      "stt": "whisper-cpu",         // 'whisper-cpu' | 'text-only'
      "kittenModel": "kitten-tts-v0.8"
    }
  }
}
```

The system never blocks on voice. If all TTS tiers are unavailable, it falls back to text-only.

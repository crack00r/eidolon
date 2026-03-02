# GPU Worker Setup — Windows

Complete guide for setting up the Eidolon GPU worker on a Windows machine with an NVIDIA GPU. The GPU worker handles TTS (Qwen3-TTS 1.7B) and STT (faster-whisper) tasks for the brain server.

## System Requirements

| Requirement | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 21H2+ | Windows 11 |
| GPU | NVIDIA with 8 GB VRAM, CUDA Compute 7.5+ | RTX 3060+ (12 GB+) |
| VRAM | 8 GB | 16 GB (RTX 5080) |
| RAM | 16 GB | 32 GB |
| Disk | 20 GB free | 40 GB free (model storage) |
| Python | 3.11+ | 3.11 or 3.12 |
| CUDA | 12.1+ | 12.4+ |
| [Tailscale](https://tailscale.com/) | Latest | Latest |

### GPU Memory Budget (RTX 5080 16 GB)

| Model | VRAM (bfloat16) | Notes |
|---|---|---|
| Qwen3-TTS 1.7B | ~3.4 GB | Always loaded |
| faster-whisper Large v3 | ~1.5 GB | Loaded on demand (int8 quantized) |
| **Total** | **~4.9 GB** | 11.1 GB free for other tasks |

## Option A: Docker (Recommended)

Docker provides a reproducible environment with the CUDA toolkit pre-configured.

### Prerequisites

1. Install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)
2. Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
3. Enable WSL 2 backend in Docker Desktop settings

### Setup

```powershell
# Clone the repository (if not already done)
git clone https://github.com/crack00r/eidolon.git
cd eidolon\services\gpu-worker

# Create the .env file
echo EIDOLON_GPU_API_KEY=your-secure-api-key-here > .env
```

> **Important:** The `EIDOLON_GPU_API_KEY` must match the `GPU_API_KEY` secret stored on the brain server. Generate a strong random key:
> ```powershell
> python -c "import secrets; print(secrets.token_urlsafe(32))"
> ```

### Build and Run

```powershell
docker compose up -d --build
```

### Verify

```powershell
# Check container status
docker compose ps
# NAME         STATUS    PORTS
# gpu-worker   Up        127.0.0.1:8420->8420/tcp

# Check health endpoint
curl http://localhost:8420/health
# {"status":"ok","gpu":{"name":"NVIDIA GeForce RTX 5080","vram_total":16384,...},"models":{"tts":{"loaded":true},"stt":{"loaded":true}}}
```

### Managing the Container

```powershell
docker compose logs -f          # Follow logs
docker compose restart          # Restart
docker compose down             # Stop and remove
docker compose up -d            # Start again
```

The container runs with security hardening: `no-new-privileges`, all capabilities dropped, read-only filesystem, 16 GB memory limit, and 256 PID limit.

## Option B: Native Installation

For development or if Docker is not available.

### 1. Install CUDA Toolkit

Download and install [CUDA Toolkit 12.4+](https://developer.nvidia.com/cuda-toolkit) from NVIDIA. Ensure the CUDA `bin` directory is in your `PATH`:

```powershell
nvcc --version
# Expected: Cuda compilation tools, release 12.4, V12.4.xxx
```

### 2. Install cuDNN

Download [cuDNN](https://developer.nvidia.com/cudnn) matching your CUDA version. Extract and copy files to the CUDA installation directory, or add the cuDNN `bin` directory to your `PATH`.

### 3. Create Python Virtual Environment

```powershell
cd eidolon\services\gpu-worker

python -m venv .venv
.venv\Scripts\activate

pip install -r requirements.txt
```

### 4. Download Models

Models are downloaded automatically on first startup, but you can pre-download them:

```powershell
# Activate venv first
python -c "from faster_whisper import WhisperModel; WhisperModel('large-v3', device='cuda', compute_type='int8')"
python -c "from transformers import AutoModelForCausalLM; AutoModelForCausalLM.from_pretrained('Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice')"
```

Model storage locations:
- Hugging Face cache: `C:\Users\<user>\.cache\huggingface\`
- faster-whisper cache: `C:\Users\<user>\.cache\huggingface\hub\`

### 5. Configure Environment

Create a `.env` file in `services/gpu-worker/`:

```ini
EIDOLON_GPU_API_KEY=your-secure-api-key-here
HOST=0.0.0.0
PORT=8420
DEVICE=cuda
TTS_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
STT_MODEL=large-v3
STT_COMPUTE_TYPE=int8
LOG_LEVEL=info
```

### 6. Run the Service

```powershell
# Activate venv
.venv\Scripts\activate

# Start the GPU worker
python -m uvicorn app.main:app --host 0.0.0.0 --port 8420
# INFO:     Uvicorn running on http://0.0.0.0:8420
# INFO:     Loading TTS model Qwen3-TTS-12Hz-1.7B-CustomVoice...
# INFO:     Loading STT model large-v3...
# INFO:     GPU Worker ready
```

## Connecting to the Brain Server

### 1. Ensure Tailscale is Running

Install Tailscale on the Windows machine and verify connectivity:

```powershell
tailscale status
# 100.x.x.x  windows-pc   ...  online
# 100.x.x.y  ubuntu-server ...  online
```

### 2. Configure the Brain Server

On the Ubuntu server, add the GPU worker to `~/.eidolon/eidolon.json`:

```jsonc
{
  "gpu": {
    "workers": [
      {
        "name": "windows-pc",
        "host": "windows-pc.tailnet.ts.net",
        "port": 8420,
        "capabilities": ["tts", "stt"],
        "healthCheckInterval": 30000
      }
    ]
  }
}
```

Set the matching API key on the brain server:

```bash
# On the Ubuntu server
eidolon secrets set GPU_API_KEY
# Enter the same key used for EIDOLON_GPU_API_KEY on the GPU worker
```

### 3. Verify from Brain Server

```bash
eidolon doctor
# ...
# ✓ GPU worker reachable (windows-pc.tailnet.ts.net:8420)
```

## Windows Firewall

Allow incoming traffic on port 8420 from the Tailscale interface only:

```powershell
# PowerShell (elevated)
New-NetFirewallRule -DisplayName "Eidolon GPU Worker" `
  -Direction Inbound -Protocol TCP -LocalPort 8420 `
  -InterfaceAlias "Tailscale" -Action Allow
```

## Running as a Windows Service

To run the GPU worker as a background service (auto-start on boot):

```powershell
# Using NSSM (Non-Sucking Service Manager)
# Download from https://nssm.cc/

nssm install EidolonGPU "C:\path\to\docker.exe" "compose -f C:\path\to\eidolon\services\gpu-worker\docker-compose.yml up"
nssm set EidolonGPU Start SERVICE_AUTO_START
nssm start EidolonGPU
```

Or for native installs, use Task Scheduler to run the Python process on login.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | GPU status, VRAM usage, model status |
| `/tts/generate` | POST | Generate speech from text (WAV) |
| `/tts/stream` | POST | Streaming TTS (Server-Sent Events) |
| `/tts/clone` | POST | Voice cloning with reference audio |
| `/stt/transcribe` | POST | Transcribe audio to text |
| `/voice/realtime` | WS | Full-duplex real-time voice chat |

All endpoints require `Authorization: Bearer <GPU_API_KEY>` header.

### Available TTS Voices

| Speaker | Description | Native Language |
|---|---|---|
| Vivian | Bright, slightly edgy young female | Chinese |
| Serena | Warm, gentle young female | Chinese |
| Ryan | Dynamic male with rhythmic drive | English |
| Aiden | Sunny American male, clear midrange | English |
| Ono_Anna | Playful Japanese female | Japanese |
| Sohee | Warm Korean female | Korean |

## Troubleshooting

### CUDA not found

```
RuntimeError: CUDA is not available
```

- Verify NVIDIA driver: `nvidia-smi`
- Verify CUDA: `nvcc --version`
- Ensure PyTorch was installed with CUDA support: `python -c "import torch; print(torch.cuda.is_available())"`
- For Docker: ensure the NVIDIA Container Toolkit is installed and Docker can see the GPU: `docker run --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`

### Out of memory (OOM)

```
torch.cuda.OutOfMemoryError: CUDA out of memory
```

- Close other GPU-intensive applications
- Check VRAM usage: `nvidia-smi`
- Use int8 quantization for STT (default): `STT_COMPUTE_TYPE=int8`
- Reduce TTS batch size in config

### Model download fails

- Check disk space (models are several GB)
- Check internet connectivity
- Set Hugging Face mirror if behind firewall: `HF_ENDPOINT=https://hf-mirror.com`
- Manual download: `huggingface-cli download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`

### Health endpoint returns unhealthy

```bash
curl http://localhost:8420/health
# {"status":"error","message":"TTS model not loaded"}
```

- Check logs: `docker compose logs` or terminal output
- First startup takes several minutes while models load
- Verify VRAM is sufficient: `nvidia-smi`

### Cannot reach GPU worker from brain server

- Verify Tailscale is connected on both machines: `tailscale status`
- Test direct connectivity: `curl http://windows-pc.tailnet.ts.net:8420/health` from the server
- Check Windows Firewall rules (see above)
- Ensure the port in `eidolon.json` matches the GPU worker port

### Docker GPU not detected

```
docker: Error response from daemon: could not select device driver "nvidia"
```

- Install NVIDIA Container Toolkit: follow [NVIDIA docs](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- Restart Docker Desktop after installation
- Verify: `docker run --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`

## Next Steps

- [Server Setup](SERVER.md) — configure the brain server
- [Network Guide](NETWORK.md) — Tailscale and connectivity details
- [Quick Start](QUICKSTART.md) — single-machine setup in 10 minutes

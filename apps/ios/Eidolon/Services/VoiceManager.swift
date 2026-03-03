/// Voice conversation manager with a state machine for the voice pipeline.
///
/// Coordinates AudioService (microphone), WebSocketService (transport to Core),
/// and AVAudioPlayer (TTS playback). Implements the voice state machine:
///   idle -> listening -> processing -> speaking -> idle
/// with interruption (barge-in) support.

import AVFoundation
import Combine

private let logCategory = "Voice"

// MARK: - VoiceState

enum VoiceState: String {
    case idle
    case listening
    case processing
    case speaking
    case interrupted
}

// MARK: - VoiceMode

enum VoiceMode: String, CaseIterable, Identifiable {
    case pushToTalk = "Push to Talk"
    case alwaysListening = "Always Listening"

    var id: String { rawValue }
}

// MARK: - VoiceManager

@MainActor
final class VoiceManager: ObservableObject {

    // MARK: Published state

    @Published private(set) var state: VoiceState = .idle
    @Published private(set) var isVoiceModeActive: Bool = false
    @Published var mode: VoiceMode = .pushToTalk
    @Published private(set) var lastTranscript: String?
    @Published private(set) var errorMessage: String?

    /// Current audio input level (0.0-1.0) for waveform visualization.
    @Published private(set) var inputLevel: Float = 0.0

    // MARK: Dependencies

    let audioService: AudioService

    private weak var webSocketService: WebSocketService?
    private var pushHandlerId: UUID?
    private var audioPlayer: AVAudioPlayer?

    /// Accumulated audio data from the current recording session.
    private var recordedAudioData = Data()

    /// Timer for silence detection in always-listening mode.
    private var silenceTimer: Task<Void, Never>?
    private let silenceThreshold: Float = 0.02
    private let silenceDurationMs: UInt64 = 1_500_000_000 // 1.5 seconds

    // MARK: - Initialization

    init(audioService: AudioService = AudioService()) {
        self.audioService = audioService
    }

    func bind(to service: WebSocketService) {
        webSocketService = service

        // Register for voice push events from the server
        pushHandlerId = service.onPush { [weak self] method, params in
            Task { @MainActor in
                self?.handlePushEvent(method: method, params: params)
            }
        }
    }

    deinit {
        if let id = pushHandlerId {
            webSocketService?.removePushHandler(id)
        }
    }

    // MARK: - Public API

    /// Activate voice mode. Requests microphone permission if needed.
    func activateVoiceMode() async {
        guard !isVoiceModeActive else { return }

        audioService.refreshPermission()

        if audioService.permissionState != .granted {
            let granted = await audioService.requestPermission()
            guard granted else {
                errorMessage = "Microphone permission is required for voice mode"
                return
            }
        }

        do {
            try audioService.configureSession()
        } catch {
            errorMessage = "Failed to configure audio: \(error.localizedDescription)"
            return
        }

        // Wire up the audio buffer callback
        audioService.onAudioBuffer = { [weak self] data in
            Task { @MainActor in
                self?.handleAudioBuffer(data)
            }
        }

        isVoiceModeActive = true
        state = .idle
        errorMessage = nil
        EidolonLogger.info(category: logCategory, message: "Voice mode activated")
    }

    /// Deactivate voice mode and release all resources.
    func deactivateVoiceMode() {
        stopListening()
        stopSpeaking()
        audioService.stopRecording()
        audioService.deactivateSession()
        audioService.onAudioBuffer = nil

        isVoiceModeActive = false
        state = .idle
        lastTranscript = nil
        errorMessage = nil
        recordedAudioData = Data()

        EidolonLogger.info(category: logCategory, message: "Voice mode deactivated")
    }

    /// Start listening for voice input (push-to-talk: call on button press).
    func startListening() {
        guard isVoiceModeActive else { return }
        guard state == .idle || state == .speaking else { return }

        // If speaking, interrupt (barge-in)
        if state == .speaking {
            interrupt()
        }

        do {
            recordedAudioData = Data()
            try audioService.startRecording()
            state = .listening
            EidolonLogger.info(category: logCategory, message: "Listening started")
        } catch {
            errorMessage = "Failed to start recording: \(error.localizedDescription)"
            EidolonLogger.error(category: logCategory, message: "startListening failed: \(error.localizedDescription)")
        }
    }

    /// Stop listening and send the recorded audio for processing.
    func stopListening() {
        guard state == .listening else { return }

        silenceTimer?.cancel()
        silenceTimer = nil
        audioService.stopRecording()

        guard !recordedAudioData.isEmpty else {
            state = .idle
            return
        }

        state = .processing
        EidolonLogger.info(
            category: logCategory,
            message: "Listening stopped, sending \(recordedAudioData.count) bytes for transcription"
        )

        sendAudioForTranscription()
    }

    /// Interrupt the current speaking state (barge-in).
    func interrupt() {
        guard state == .speaking else { return }

        state = .interrupted
        stopSpeaking()

        // Notify server of interruption
        Task {
            do {
                let _: AnyCodable? = try await webSocketService?.call(
                    method: GatewayMethod.voiceStop.rawValue,
                    params: ["reason": "interrupted"]
                )
            } catch {
                EidolonLogger.debug(
                    category: logCategory,
                    message: "Failed to send voice.stop: \(error.localizedDescription)"
                )
            }
        }

        state = .idle
        EidolonLogger.info(category: logCategory, message: "Voice interrupted (barge-in)")
    }

    // MARK: - Audio Buffer Handling

    private func handleAudioBuffer(_ data: Data) {
        guard state == .listening else { return }

        recordedAudioData.append(data)
        inputLevel = audioService.currentLevel

        // In always-listening mode, detect silence to auto-stop
        if mode == .alwaysListening {
            handleSilenceDetection()
        }
    }

    private func handleSilenceDetection() {
        if audioService.currentLevel < silenceThreshold {
            // Start or continue silence timer
            if silenceTimer == nil {
                silenceTimer = Task {
                    try? await Task.sleep(nanoseconds: silenceDurationMs)
                    guard !Task.isCancelled else { return }
                    // Silence lasted long enough, stop listening
                    if self.state == .listening && self.audioService.currentLevel < self.silenceThreshold {
                        self.stopListening()
                    }
                }
            }
        } else {
            // Speech detected, cancel silence timer
            silenceTimer?.cancel()
            silenceTimer = nil
        }
    }

    // MARK: - Audio Transmission

    private func sendAudioForTranscription() {
        guard let service = webSocketService,
              service.connectionState == .connected else {
            errorMessage = "Not connected to server"
            state = .idle
            return
        }

        let audioData = recordedAudioData
        recordedAudioData = Data()

        Task {
            do {
                // Send audio to server as base64-encoded PCM data
                let base64Audio = audioData.base64EncodedString()

                let response: VoiceTranscriptionResponse = try await service.call(
                    method: GatewayMethod.voiceStart.rawValue,
                    params: [
                        "audio": base64Audio,
                        "format": "pcm_16khz_16bit_mono",
                        "sampleRate": 16000,
                        "respondWithVoice": true,
                    ]
                )

                lastTranscript = response.transcript

                if let audioBase64 = response.audioResponse {
                    // Server sent TTS audio back
                    playTTSResponse(base64Audio: audioBase64)
                } else if let textResponse = response.textResponse {
                    // Text-only response (no TTS available)
                    lastTranscript = textResponse
                    state = .idle
                }

            } catch {
                errorMessage = "Voice processing failed: \(ChatViewModel.sanitizeError(error))"
                state = .idle
                EidolonLogger.error(
                    category: logCategory,
                    message: "Voice transcription failed: \(error.localizedDescription)"
                )
            }
        }
    }

    // MARK: - TTS Playback

    private func playTTSResponse(base64Audio: String) {
        guard let audioData = Data(base64Encoded: base64Audio) else {
            EidolonLogger.warning(category: logCategory, message: "Invalid base64 TTS audio data")
            state = .idle
            return
        }

        do {
            audioPlayer = try AVAudioPlayer(data: audioData)
            audioPlayer?.delegate = AudioPlayerDelegateHandler.shared
            AudioPlayerDelegateHandler.shared.onFinished = { [weak self] in
                Task { @MainActor in
                    self?.handlePlaybackFinished()
                }
            }
            audioPlayer?.play()
            state = .speaking
            EidolonLogger.info(category: logCategory, message: "TTS playback started")
        } catch {
            EidolonLogger.warning(
                category: logCategory,
                message: "Failed to play TTS audio: \(error.localizedDescription)"
            )
            state = .idle
        }
    }

    private func stopSpeaking() {
        audioPlayer?.stop()
        audioPlayer = nil
    }

    private func handlePlaybackFinished() {
        audioPlayer = nil

        if state == .speaking {
            state = .idle
            EidolonLogger.info(category: logCategory, message: "TTS playback finished")

            // In always-listening mode, automatically start listening again
            if mode == .alwaysListening && isVoiceModeActive {
                startListening()
            }
        }
    }

    // MARK: - Server Push Events

    private func handlePushEvent(method: String, params: [String: AnyCodable]) {
        switch method {
        case "voice.audio":
            // Streaming TTS audio chunk from server
            if let audioBase64 = params["audio"]?.stringValue {
                playTTSResponse(base64Audio: audioBase64)
            }

        case "voice.transcript":
            // Server-side transcription result
            if let text = params["text"]?.stringValue {
                lastTranscript = text
            }

        case "voice.state":
            // Server-side state update
            if let stateStr = params["state"]?.stringValue,
               let newState = VoiceState(rawValue: stateStr) {
                state = newState
            }

        case "voice.error":
            if let message = params["message"]?.stringValue {
                errorMessage = message
                state = .idle
            }

        default:
            break
        }
    }
}

// MARK: - Response Types

private struct VoiceTranscriptionResponse: Decodable {
    let transcript: String?
    let textResponse: String?
    let audioResponse: String?
}

// MARK: - AudioPlayerDelegateHandler

/// Bridges AVAudioPlayerDelegate callbacks to closures.
/// Shared singleton since AVAudioPlayerDelegate must be a class (NSObject).
private final class AudioPlayerDelegateHandler: NSObject, AVAudioPlayerDelegate {
    static let shared = AudioPlayerDelegateHandler()

    var onFinished: (() -> Void)?

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onFinished?()
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        if let error {
            EidolonLogger.warning(
                category: "Voice",
                message: "Audio decode error: \(error.localizedDescription)"
            )
        }
        onFinished?()
    }
}

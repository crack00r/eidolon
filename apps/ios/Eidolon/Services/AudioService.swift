/// Audio capture and playback service using AVAudioEngine.
///
/// Manages the AVAudioSession lifecycle, microphone recording via a tap
/// on the input node, and audio buffer delivery to consumers. The service
/// does NOT perform speech-to-text or voice activity detection; it provides
/// raw PCM audio buffers.

import AVFoundation
import Combine

private let logCategory = "Audio"

// MARK: - AudioPermissionState

enum AudioPermissionState: String {
    case notDetermined
    case granted
    case denied
}

// MARK: - AudioServiceError

enum AudioServiceError: LocalizedError {
    case permissionDenied
    case sessionConfigurationFailed(String)
    case engineStartFailed(String)
    case noInputNode

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Microphone permission denied"
        case .sessionConfigurationFailed(let detail):
            return "Audio session configuration failed: \(detail)"
        case .engineStartFailed(let detail):
            return "Audio engine failed to start: \(detail)"
        case .noInputNode:
            return "No audio input node available"
        }
    }
}

// MARK: - AudioService

@MainActor
final class AudioService: ObservableObject {

    // MARK: Published state

    @Published private(set) var permissionState: AudioPermissionState = .notDetermined
    @Published private(set) var isRecording: Bool = false
    @Published private(set) var currentLevel: Float = 0.0

    // MARK: Audio buffer callback

    /// Called on a background queue whenever a new audio buffer is available.
    /// The buffer contains mono 16-bit PCM at 16 kHz (suitable for STT).
    var onAudioBuffer: ((Data) -> Void)?

    // MARK: Configuration

    /// Target sample rate for captured audio sent to the server.
    static let targetSampleRate: Double = 16_000
    static let targetChannelCount: AVAudioChannelCount = 1

    // MARK: Internals

    private let audioEngine = AVAudioEngine()
    private var isSessionConfigured = false

    /// Converter from input hardware format to 16 kHz mono PCM.
    private var formatConverter: AVAudioConverter?

    // MARK: - Permission

    /// Check current microphone permission without prompting.
    func refreshPermission() {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            permissionState = .granted
        case .denied:
            permissionState = .denied
        case .undetermined:
            permissionState = .notDetermined
        @unknown default:
            permissionState = .notDetermined
        }
    }

    /// Request microphone permission. Returns true if granted.
    func requestPermission() async -> Bool {
        let granted = await AVAudioApplication.requestRecordPermission()
        permissionState = granted ? .granted : .denied

        if granted {
            EidolonLogger.info(category: logCategory, message: "Microphone permission granted")
        } else {
            EidolonLogger.warning(category: logCategory, message: "Microphone permission denied")
        }

        return granted
    }

    // MARK: - Session Configuration

    /// Configure the AVAudioSession for voice chat (play + record, echo cancelled).
    func configureSession() throws {
        let session = AVAudioSession.sharedInstance()

        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetooth]
            )
            try session.setPreferredSampleRate(Self.targetSampleRate)
            try session.setPreferredIOBufferDuration(0.02) // 20 ms buffer
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            isSessionConfigured = true
            EidolonLogger.info(
                category: logCategory,
                message: "Audio session configured: rate=\(session.sampleRate) Hz, " +
                    "channels=\(session.inputNumberOfChannels)"
            )
        } catch {
            isSessionConfigured = false
            throw AudioServiceError.sessionConfigurationFailed(error.localizedDescription)
        }
    }

    /// Deactivate the audio session and release resources.
    func deactivateSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            isSessionConfigured = false
            EidolonLogger.info(category: logCategory, message: "Audio session deactivated")
        } catch {
            EidolonLogger.warning(category: logCategory, message: "Failed to deactivate audio session: \(error.localizedDescription)")
        }
    }

    // MARK: - Recording

    /// Start capturing audio from the microphone.
    func startRecording() throws {
        guard permissionState == .granted else {
            throw AudioServiceError.permissionDenied
        }

        guard !isRecording else { return }

        if !isSessionConfigured {
            try configureSession()
        }

        let inputNode = audioEngine.inputNode
        let hardwareFormat = inputNode.outputFormat(forBus: 0)

        guard hardwareFormat.channelCount > 0 else {
            throw AudioServiceError.noInputNode
        }

        // Set up format converter: hardware format -> 16 kHz mono PCM 16-bit
        let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Self.targetSampleRate,
            channels: Self.targetChannelCount,
            interleaved: true
        )!

        if hardwareFormat.sampleRate != Self.targetSampleRate || hardwareFormat.channelCount != Self.targetChannelCount {
            formatConverter = AVAudioConverter(from: hardwareFormat, to: targetFormat)
        } else {
            formatConverter = nil
        }

        // Install a tap on the input node to receive audio buffers
        let bufferSize: AVAudioFrameCount = 1024
        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: hardwareFormat) { [weak self] buffer, _ in
            self?.processAudioBuffer(buffer, targetFormat: targetFormat)
        }

        do {
            try audioEngine.start()
            isRecording = true
            EidolonLogger.info(
                category: logCategory,
                message: "Recording started: hardware=\(hardwareFormat.sampleRate) Hz, " +
                    "\(hardwareFormat.channelCount) ch"
            )
        } catch {
            inputNode.removeTap(onBus: 0)
            throw AudioServiceError.engineStartFailed(error.localizedDescription)
        }
    }

    /// Stop capturing audio.
    func stopRecording() {
        guard isRecording else { return }

        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        isRecording = false
        currentLevel = 0.0
        formatConverter = nil

        EidolonLogger.info(category: logCategory, message: "Recording stopped")
    }

    // MARK: - Audio Processing

    private func processAudioBuffer(_ buffer: AVAudioPCMBuffer, targetFormat: AVAudioFormat) {
        // Calculate RMS level for the waveform visualizer
        let level = Self.calculateRMSLevel(buffer: buffer)
        Task { @MainActor in
            self.currentLevel = level
        }

        let outputData: Data

        if let converter = formatConverter {
            // Convert to target format
            guard let converted = Self.convert(buffer: buffer, using: converter, targetFormat: targetFormat) else {
                return
            }
            outputData = Self.pcmBufferToData(converted)
        } else {
            outputData = Self.pcmBufferToData(buffer)
        }

        guard !outputData.isEmpty else { return }

        onAudioBuffer?(outputData)
    }

    // MARK: - Utilities

    /// Convert an audio buffer to the target format using the provided converter.
    private static func convert(
        buffer: AVAudioPCMBuffer,
        using converter: AVAudioConverter,
        targetFormat: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let outputFrameCount = AVAudioFrameCount(Double(buffer.frameLength) * ratio)

        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputFrameCount) else {
            return nil
        }

        var error: NSError?
        var consumed = false

        converter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }

        if let error {
            EidolonLogger.debug(category: logCategory, message: "Audio conversion error: \(error.localizedDescription)")
            return nil
        }

        return outputBuffer
    }

    /// Extract raw PCM bytes from an AVAudioPCMBuffer.
    private static func pcmBufferToData(_ buffer: AVAudioPCMBuffer) -> Data {
        let audioBuffer = buffer.audioBufferList.pointee.mBuffers
        guard let baseAddress = audioBuffer.mData else { return Data() }
        return Data(bytes: baseAddress, count: Int(audioBuffer.mDataByteSize))
    }

    /// Calculate the RMS (root mean square) level of a PCM buffer, normalized to 0.0-1.0.
    private static func calculateRMSLevel(buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData else { return 0.0 }
        let channelPointer = channelData[0]
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return 0.0 }

        var sumOfSquares: Float = 0.0
        for i in 0..<frameLength {
            let sample = channelPointer[i]
            sumOfSquares += sample * sample
        }

        let rms = sqrt(sumOfSquares / Float(frameLength))
        // Clamp to 0..1 range; typical speech RMS is 0.01-0.3
        return min(rms * 5.0, 1.0)
    }
}

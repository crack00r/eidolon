/// Full-screen voice conversation overlay.
///
/// Displays the current voice state with visual feedback:
/// - Idle: microphone icon, tap to start
/// - Listening: animated waveform, recording indicator
/// - Processing: spinner, "Thinking..." label
/// - Speaking: animated output waveform, tap to interrupt

import SwiftUI

struct VoiceOverlay: View {
    @ObservedObject var voiceManager: VoiceManager
    let onDismiss: () -> Void

    @State private var waveformPhase: CGFloat = 0.0

    var body: some View {
        ZStack {
            // Blurred background
            EidolonColors.background
                .ignoresSafeArea()

            VStack(spacing: 32) {
                headerBar
                Spacer()
                stateVisual
                stateLabel
                Spacer()
                transcriptView
                controlBar
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
        }
        .onAppear {
            startWaveformAnimation()
        }
    }

    // MARK: - Header

    private var headerBar: some View {
        HStack {
            VoiceStateBadge(state: voiceManager.state)
            Spacer()
            Button {
                voiceManager.deactivateVoiceMode()
                onDismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 28))
                    .foregroundColor(.secondary)
            }
            .accessibilityLabel("Close voice mode")
        }
    }

    // MARK: - State Visual

    @ViewBuilder
    private var stateVisual: some View {
        switch voiceManager.state {
        case .idle:
            idleVisual
        case .listening:
            listeningVisual
        case .processing:
            processingVisual
        case .speaking:
            speakingVisual
        case .interrupted:
            idleVisual
        }
    }

    private var idleVisual: some View {
        Circle()
            .fill(EidolonColors.secondary)
            .frame(width: 160, height: 160)
            .overlay(
                Image(systemName: "mic.fill")
                    .font(.system(size: 56))
                    .foregroundColor(EidolonColors.accent)
            )
            .accessibilityHidden(true)
    }

    private var listeningVisual: some View {
        ZStack {
            // Pulsing ring
            Circle()
                .stroke(EidolonColors.accent.opacity(0.3), lineWidth: 4)
                .frame(width: 180 + CGFloat(voiceManager.inputLevel) * 40, height: 180 + CGFloat(voiceManager.inputLevel) * 40)
                .animation(.easeInOut(duration: 0.1), value: voiceManager.inputLevel)

            Circle()
                .fill(EidolonColors.accent.opacity(0.2))
                .frame(width: 160, height: 160)

            // Waveform bars
            WaveformView(level: voiceManager.inputLevel, phase: waveformPhase, barCount: 7)
                .frame(width: 120, height: 60)

            // Recording dot
            Circle()
                .fill(Color.red)
                .frame(width: 12, height: 12)
                .offset(y: -90)
                .opacity(pulsingOpacity)
        }
        .accessibilityHidden(true)
    }

    private var processingVisual: some View {
        ZStack {
            Circle()
                .fill(EidolonColors.secondary)
                .frame(width: 160, height: 160)

            ProgressView()
                .scaleEffect(2.0)
                .tint(EidolonColors.accent)
        }
        .accessibilityHidden(true)
    }

    private var speakingVisual: some View {
        ZStack {
            Circle()
                .fill(EidolonColors.accent.opacity(0.15))
                .frame(width: 160, height: 160)

            // Output waveform (simulated since we control playback)
            WaveformView(level: 0.4, phase: waveformPhase, barCount: 7)
                .frame(width: 120, height: 60)
                .foregroundColor(EidolonColors.accent)

            Image(systemName: "speaker.wave.3.fill")
                .font(.system(size: 24))
                .foregroundColor(EidolonColors.accent)
                .offset(y: 50)
        }
        .accessibilityHidden(true)
    }

    /// Pulsing opacity for the recording indicator dot.
    private var pulsingOpacity: Double {
        // Approximate a pulse using the waveform phase
        (sin(waveformPhase * .pi * 2) + 1) / 2 * 0.7 + 0.3
    }

    // MARK: - State Label

    private var stateLabel: some View {
        Text(stateLabelText)
            .font(.title3)
            .fontWeight(.medium)
            .foregroundColor(.primary)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("voiceStateLabel")
    }

    private var stateLabelText: String {
        switch voiceManager.state {
        case .idle:
            return voiceManager.mode == .pushToTalk
                ? "Tap and hold to speak"
                : "Tap to start listening"
        case .listening:
            return "Listening..."
        case .processing:
            return "Thinking..."
        case .speaking:
            return "Eidolon is speaking"
        case .interrupted:
            return "Interrupted"
        }
    }

    // MARK: - Transcript

    @ViewBuilder
    private var transcriptView: some View {
        if let transcript = voiceManager.lastTranscript, !transcript.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Last transcript:")
                    .font(.caption)
                    .foregroundColor(.secondary)

                Text(transcript)
                    .font(.subheadline)
                    .foregroundColor(.primary)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(EidolonColors.secondary)
                    .cornerRadius(12)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Last transcript: \(transcript)")
            .accessibilityIdentifier("voiceTranscript")
        }

        if let error = voiceManager.errorMessage {
            Text(error)
                .font(.caption)
                .foregroundColor(EidolonColors.error)
                .multilineTextAlignment(.center)
                .accessibilityLabel("Voice error: \(error)")
        }
    }

    // MARK: - Control Bar

    private var controlBar: some View {
        HStack(spacing: 32) {
            // Mode picker
            Menu {
                ForEach(VoiceMode.allCases) { voiceMode in
                    Button {
                        voiceManager.mode = voiceMode
                    } label: {
                        if voiceManager.mode == voiceMode {
                            Label(voiceMode.rawValue, systemImage: "checkmark")
                        } else {
                            Text(voiceMode.rawValue)
                        }
                    }
                }
            } label: {
                Image(systemName: "gear")
                    .font(.system(size: 24))
                    .foregroundColor(.secondary)
                    .frame(width: 56, height: 56)
                    .background(EidolonColors.secondary)
                    .clipShape(Circle())
            }
            .accessibilityLabel("Voice mode settings")

            // Main action button
            mainActionButton

            // Interrupt / stop button
            Button {
                if voiceManager.state == .speaking {
                    voiceManager.interrupt()
                } else if voiceManager.state == .listening {
                    voiceManager.stopListening()
                }
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 24))
                    .foregroundColor(stopButtonEnabled ? EidolonColors.error : .gray)
                    .frame(width: 56, height: 56)
                    .background(EidolonColors.secondary)
                    .clipShape(Circle())
            }
            .disabled(!stopButtonEnabled)
            .accessibilityLabel("Stop")
        }
        .padding(.bottom, 16)
    }

    private var stopButtonEnabled: Bool {
        voiceManager.state == .listening || voiceManager.state == .speaking
    }

    @ViewBuilder
    private var mainActionButton: some View {
        let isActive = voiceManager.state == .listening

        if voiceManager.mode == .pushToTalk {
            // Press and hold
            Circle()
                .fill(isActive ? EidolonColors.accent : EidolonColors.secondary)
                .frame(width: 80, height: 80)
                .overlay(
                    Image(systemName: isActive ? "mic.fill" : "mic")
                        .font(.system(size: 36))
                        .foregroundColor(isActive ? .white : EidolonColors.accent)
                )
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { _ in
                            if voiceManager.state != .listening {
                                voiceManager.startListening()
                            }
                        }
                        .onEnded { _ in
                            voiceManager.stopListening()
                        }
                )
                .accessibilityLabel("Hold to speak")
        } else {
            // Toggle
            Button {
                if voiceManager.state == .idle {
                    voiceManager.startListening()
                } else if voiceManager.state == .listening {
                    voiceManager.stopListening()
                }
            } label: {
                Circle()
                    .fill(isActive ? EidolonColors.accent : EidolonColors.secondary)
                    .frame(width: 80, height: 80)
                    .overlay(
                        Image(systemName: isActive ? "mic.fill" : "mic")
                            .font(.system(size: 36))
                            .foregroundColor(isActive ? .white : EidolonColors.accent)
                    )
            }
            .accessibilityLabel(isActive ? "Stop listening" : "Start listening")
        }
    }

    // MARK: - Animation

    private func startWaveformAnimation() {
        withAnimation(.linear(duration: 2.0).repeatForever(autoreverses: false)) {
            waveformPhase = 1.0
        }
    }
}

// MARK: - Voice State Badge

struct VoiceStateBadge: View {
    let state: VoiceState

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(badgeColor)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(state.rawValue.capitalized)
                .font(.caption2)
                .fontWeight(.medium)
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.secondary.opacity(0.15))
        .cornerRadius(12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Voice state")
        .accessibilityValue(state.rawValue.capitalized)
    }

    private var badgeColor: Color {
        switch state {
        case .idle:         return .gray
        case .listening:    return EidolonColors.accent
        case .processing:   return EidolonColors.warning
        case .speaking:     return EidolonColors.success
        case .interrupted:  return EidolonColors.error
        }
    }
}

// MARK: - Waveform View

/// Animated bar waveform that responds to audio input level.
struct WaveformView: View {
    let level: Float
    let phase: CGFloat
    let barCount: Int

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<barCount, id: \.self) { index in
                RoundedRectangle(cornerRadius: 3)
                    .fill(EidolonColors.accent)
                    .frame(width: 6, height: barHeight(for: index))
                    .animation(.easeInOut(duration: 0.1), value: level)
            }
        }
        .accessibilityHidden(true)
    }

    private func barHeight(for index: Int) -> CGFloat {
        let normalizedIndex = CGFloat(index) / CGFloat(barCount - 1)
        // Create a wave pattern: bars in the center are taller
        let centerFactor = 1.0 - abs(normalizedIndex - 0.5) * 2.0
        let phaseOffset = sin((normalizedIndex + phase) * .pi * 2) * 0.3

        let baseHeight: CGFloat = 8
        let levelContribution = CGFloat(level) * 50 * (centerFactor + 0.3)
        let animatedContribution = CGFloat(phaseOffset) * CGFloat(max(level, 0.1)) * 20

        return max(baseHeight, baseHeight + levelContribution + animatedContribution)
    }
}

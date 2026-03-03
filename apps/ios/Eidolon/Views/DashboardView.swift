/// Dashboard view -- shows system status, cognitive state, energy usage,
/// active tasks, memory count, and uptime.

import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var webSocketService: WebSocketService
    @StateObject private var viewModel = DashboardViewModel()

    var body: some View {
        NavigationStack {
            ScrollView {
                if viewModel.isLoading && viewModel.status == nil {
                    loadingView
                } else if let error = viewModel.errorMessage, viewModel.status == nil {
                    errorView(message: error)
                } else if let status = viewModel.status {
                    statusContent(status)
                } else {
                    disconnectedView
                }
            }
            .background(EidolonColors.background)
            .navigationTitle("Dashboard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    ConnectionStatusBadge(state: webSocketService.connectionState)
                }
            }
            .onAppear {
                viewModel.bind(to: webSocketService)
                viewModel.startPolling()
            }
            .onDisappear {
                viewModel.stopPolling()
            }
            .refreshable {
                await viewModel.fetchStatus()
            }
        }
    }

    // MARK: - Status Content

    private func statusContent(_ status: SystemStatus) -> some View {
        VStack(spacing: 16) {
            // Cognitive state card
            statusCard {
                VStack(spacing: 12) {
                    Image(systemName: status.stateIcon)
                        .font(.system(size: 36))
                        .foregroundColor(status.stateColor)

                    Text(status.cognitiveState.capitalized)
                        .font(.title3)
                        .fontWeight(.semibold)

                    Text("Cognitive State")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }

            // Stats grid
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                statCard(
                    icon: "brain",
                    label: "Memories",
                    value: "\(status.memoryCount)",
                    color: EidolonColors.accent
                )

                statCard(
                    icon: "checklist",
                    label: "Active Tasks",
                    value: "\(status.activeTasks)",
                    color: EidolonColors.success
                )

                statCard(
                    icon: "desktopcomputer",
                    label: "Clients",
                    value: "\(status.connectedClients)",
                    color: .blue
                )

                statCard(
                    icon: "clock",
                    label: "Uptime",
                    value: status.uptimeFormatted,
                    color: EidolonColors.warning
                )
            }

            // Energy budget card
            statusCard {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: "bolt.fill")
                            .foregroundColor(energyColor(status.energyPercent))
                        Text("Energy Budget")
                            .font(.subheadline)
                            .fontWeight(.semibold)
                        Spacer()
                        Text("\(Int(status.energyPercent * 100))%")
                            .font(.subheadline)
                            .fontWeight(.semibold)
                            .foregroundColor(energyColor(status.energyPercent))
                    }

                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 4)
                                .fill(Color.secondary.opacity(0.2))
                                .frame(height: 8)

                            RoundedRectangle(cornerRadius: 4)
                                .fill(energyColor(status.energyPercent))
                                .frame(width: geo.size.width * status.energyPercent, height: 8)
                        }
                    }
                    .frame(height: 8)

                    HStack {
                        Text(String(format: "%.0f / %.0f tokens", status.energyUsed, status.energyBudget))
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Spacer()
                    }
                }
            }

            // Server info
            if let version = status.serverVersion {
                statusCard {
                    HStack {
                        Image(systemName: "server.rack")
                            .foregroundColor(.secondary)
                        Text("Server Version")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        Spacer()
                        Text(version)
                            .font(.subheadline)
                            .fontWeight(.medium)
                    }
                }
            }
        }
        .padding(16)
    }

    // MARK: - Components

    private func statusCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(16)
            .background(EidolonColors.secondary)
            .cornerRadius(12)
    }

    private func statCard(icon: String, label: String, value: String, color: Color) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 24))
                .foregroundColor(color)

            Text(value)
                .font(.title2)
                .fontWeight(.bold)
                .foregroundColor(.primary)

            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background(EidolonColors.secondary)
        .cornerRadius(12)
    }

    private func energyColor(_ percent: Double) -> Color {
        if percent < 0.5 {
            return EidolonColors.success
        } else if percent < 0.8 {
            return EidolonColors.warning
        } else {
            return EidolonColors.error
        }
    }

    // MARK: - Empty States

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading status...")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }

    private var disconnectedView: some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("Not Connected")
                .font(.headline)
                .foregroundColor(.secondary)
            Text("Connect to the gateway to view status")
                .font(.subheadline)
                .foregroundColor(.secondary.opacity(0.7))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 100)
    }

    private func errorView(message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundColor(EidolonColors.warning)
            Text(message)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 100)
        .padding(.horizontal)
    }
}

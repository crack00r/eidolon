/// Settings screen — connection configuration, discovery, and status.

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var webSocketService: WebSocketService
    @EnvironmentObject var networkManager: NetworkManager
    @StateObject private var viewModel = SettingsViewModel()

    var body: some View {
        NavigationStack {
            Form {
                connectionSection
                discoverySection
                statusSection
                aboutSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                viewModel.bind(webSocket: webSocketService, network: networkManager)
            }
        }
    }

    // MARK: - Connection

    private var connectionSection: some View {
        Section("Connection") {
            HStack {
                Text("Host")
                    .foregroundColor(.secondary)
                TextField("127.0.0.1", text: $viewModel.host)
                    .multilineTextAlignment(.trailing)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }

            HStack {
                Text("Port")
                    .foregroundColor(.secondary)
                TextField("8419", value: $viewModel.port, format: .number)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.numberPad)
            }

            HStack {
                Text("Token")
                    .foregroundColor(.secondary)
                SecureField("Authentication token", text: $viewModel.token)
                    .multilineTextAlignment(.trailing)
            }

            HStack(spacing: 12) {
                Button {
                    viewModel.connect()
                } label: {
                    Text("Connect")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(EidolonColors.accent)
                .disabled(webSocketService.connectionState == .connected
                          || webSocketService.connectionState == .connecting)

                Button {
                    viewModel.disconnect()
                } label: {
                    Text("Disconnect")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(webSocketService.connectionState == .disconnected)
            }
        }
    }

    // MARK: - Discovery

    private var discoverySection: some View {
        Section("Discovery") {
            Picker("Method", selection: .constant(networkManager.connectionMethod)) {
                ForEach(ConnectionMethod.allCases) { method in
                    Text(method.rawValue).tag(method)
                }
            }
            .disabled(true) // Read-only, shows current detection method

            HStack {
                Text("Tailscale IP")
                    .foregroundColor(.secondary)
                TextField("100.x.x.x", text: $viewModel.tailscaleHost)
                    .multilineTextAlignment(.trailing)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }

            HStack {
                Text("Cloudflare URL")
                    .foregroundColor(.secondary)
                TextField("https://eidolon.example.com", text: $viewModel.cloudflareUrl)
                    .multilineTextAlignment(.trailing)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }

            Button {
                viewModel.startDiscovery()
            } label: {
                HStack {
                    Text("Scan Network")
                    Spacer()
                    if networkManager.isDiscovering {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                    }
                }
            }

            if !networkManager.discoveredEndpoints.isEmpty {
                ForEach(networkManager.discoveredEndpoints) { endpoint in
                    Button {
                        if let host = networkManager.discoveredHost {
                            viewModel.applyDiscoveredHost(host)
                        }
                    } label: {
                        HStack {
                            Image(systemName: "checkmark.circle")
                                .foregroundColor(EidolonColors.success)
                            VStack(alignment: .leading) {
                                Text(endpoint.name)
                                    .font(.subheadline)
                                Text(endpoint.method.rawValue)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Status

    private var statusSection: some View {
        Section("Status") {
            HStack {
                Text("Connection")
                    .foregroundColor(.secondary)
                Spacer()
                ConnectionStatusBadge(state: webSocketService.connectionState)
            }

            if let error = webSocketService.lastError {
                HStack {
                    Text("Error")
                        .foregroundColor(.secondary)
                    Spacer()
                    Text(error)
                        .font(.caption)
                        .foregroundColor(EidolonColors.error)
                        .lineLimit(2)
                }
            }

            if let version = viewModel.serverVersion {
                HStack {
                    Text("Server Version")
                        .foregroundColor(.secondary)
                    Spacer()
                    Text(version)
                        .font(.caption)
                }
            }

            Button {
                Task { await viewModel.testConnection() }
            } label: {
                HStack {
                    Text("Test Connection")
                    Spacer()
                    if viewModel.isTestingConnection {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Image(systemName: "bolt.circle")
                    }
                }
            }

            if let result = viewModel.testResult {
                Text(result)
                    .font(.caption)
                    .foregroundColor(result.hasPrefix("Connected") ? EidolonColors.success : EidolonColors.error)
            }
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section("About") {
            HStack {
                Text("App")
                    .foregroundColor(.secondary)
                Spacer()
                Text("Eidolon iOS")
            }

            HStack {
                Text("Version")
                    .foregroundColor(.secondary)
                Spacer()
                Text(appVersion)
            }

            HStack {
                Text("Build")
                    .foregroundColor(.secondary)
                Spacer()
                Text(buildNumber)
            }

            HStack {
                Text("Gateway Port")
                    .foregroundColor(.secondary)
                Spacer()
                Text("8419")
                    .font(.caption)
                    .monospaced()
            }
        }
    }

    // MARK: - App Info

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    }
}

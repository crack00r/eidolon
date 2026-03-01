/// Root view with tab navigation and connection status indicator.

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var webSocketService: WebSocketService

    var body: some View {
        TabView {
            ChatView()
                .tabItem {
                    Label("Chat", systemImage: "bubble.left.and.bubble.right")
                }

            MemoryView()
                .tabItem {
                    Label("Memory", systemImage: "brain")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
        }
        .accentColor(EidolonColors.accent)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                ConnectionStatusBadge(state: webSocketService.connectionState)
            }
        }
    }
}

// MARK: - Connection Status Badge

struct ConnectionStatusBadge: View {
    let state: ConnectionState

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(indicatorColor)
                .frame(width: 8, height: 8)
            Text(state.label)
                .font(.caption2)
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color.secondary.opacity(0.15))
        .cornerRadius(12)
    }

    private var indicatorColor: Color {
        switch state {
        case .connected:
            return EidolonColors.success
        case .connecting, .authenticating:
            return EidolonColors.warning
        case .disconnected:
            return .gray
        case .error:
            return EidolonColors.error
        }
    }
}

// MARK: - Color Palette

/// Design-system colors consistent with the desktop client.
enum EidolonColors {
    static let background = Color(red: 0.10, green: 0.10, blue: 0.18)
    static let secondary  = Color(red: 0.09, green: 0.13, blue: 0.24)
    static let accent     = Color(red: 0.91, green: 0.27, blue: 0.38)
    static let success    = Color.green
    static let warning    = Color.orange
    static let error      = Color.red
}

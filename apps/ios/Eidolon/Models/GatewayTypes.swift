/// JSON-RPC 2.0 types for the Eidolon gateway protocol.
/// Mirrors the TypeScript definitions in `packages/protocol/src/types/gateway.ts`.

import Foundation

// MARK: - Connection State

enum ConnectionState: String, Codable {
    case disconnected
    case connecting
    case authenticating
    case connected
    case error

    var label: String {
        switch self {
        case .disconnected:    return "Disconnected"
        case .connecting:      return "Connecting"
        case .authenticating:  return "Authenticating"
        case .connected:       return "Connected"
        case .error:           return "Error"
        }
    }
}

// MARK: - JSON-RPC Request

struct GatewayRequest: Codable {
    let jsonrpc: String
    let id: String
    let method: String
    let params: [String: AnyCodable]?

    init(id: String, method: String, params: [String: AnyCodable]? = nil) {
        self.jsonrpc = "2.0"
        self.id = id
        self.method = method
        self.params = params
    }
}

// MARK: - JSON-RPC Response

struct GatewayResponse: Codable {
    let jsonrpc: String
    let id: String?
    let result: AnyCodable?
    let error: GatewayError?
    let method: String?
    let params: [String: AnyCodable]?
}

// MARK: - JSON-RPC Error

struct GatewayError: Codable {
    let code: Int
    let message: String
    let data: AnyCodable?
}

// MARK: - Push Event (server → client, no id)

struct GatewayPushEvent: Codable {
    let jsonrpc: String
    let method: String
    let params: [String: AnyCodable]
}

// MARK: - Authentication

struct ClientAuth: Codable {
    let type: String
    let token: String

    init(token: String) {
        self.type = "token"
        self.token = token
    }
}

// MARK: - Known RPC Methods

enum GatewayMethod: String {
    case chatSend       = "chat.send"
    case chatStream     = "chat.stream"
    case memorySearch   = "memory.search"
    case memoryDelete   = "memory.delete"
    case sessionList    = "session.list"
    case sessionInfo    = "session.info"
    case learningList   = "learning.list"
    case learningApprove = "learning.approve"
    case learningReject = "learning.reject"
    case systemStatus   = "system.status"
    case systemHealth   = "system.health"
    case voiceStart     = "voice.start"
    case voiceStop      = "voice.stop"
    case authAuthenticate = "auth.authenticate"
    case clientReportErrors = "client.reportErrors"
}

// MARK: - AnyCodable

/// Lightweight type-erased `Codable` wrapper that handles encoding/decoding
/// of arbitrary JSON values (String, Int, Double, Bool, Array, Dictionary, nil).
struct AnyCodable: Codable, Equatable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    // MARK: Decodable

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self.value = NSNull()
        } else if let boolValue = try? container.decode(Bool.self) {
            self.value = boolValue
        } else if let intValue = try? container.decode(Int.self) {
            self.value = intValue
        } else if let doubleValue = try? container.decode(Double.self) {
            self.value = doubleValue
        } else if let stringValue = try? container.decode(String.self) {
            self.value = stringValue
        } else if let arrayValue = try? container.decode([AnyCodable].self) {
            self.value = arrayValue.map(\.value)
        } else if let dictValue = try? container.decode([String: AnyCodable].self) {
            self.value = dictValue.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "AnyCodable cannot decode value"
            )
        }
    }

    // MARK: Encodable

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch value {
        case is NSNull:
            try container.encodeNil()
        case let boolValue as Bool:
            try container.encode(boolValue)
        case let intValue as Int:
            try container.encode(intValue)
        case let doubleValue as Double:
            try container.encode(doubleValue)
        case let stringValue as String:
            try container.encode(stringValue)
        case let arrayValue as [Any]:
            try container.encode(arrayValue.map { AnyCodable($0) })
        case let dictValue as [String: Any]:
            try container.encode(dictValue.mapValues { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: container.codingPath,
                    debugDescription: "AnyCodable cannot encode value of type \(type(of: value))"
                )
            )
        }
    }

    // MARK: Equatable

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        switch (lhs.value, rhs.value) {
        case (is NSNull, is NSNull):
            return true
        case let (l as Bool, r as Bool):
            return l == r
        case let (l as Int, r as Int):
            return l == r
        case let (l as Double, r as Double):
            return l == r
        case let (l as String, r as String):
            return l == r
        default:
            return false
        }
    }

    // MARK: Convenience accessors

    var stringValue: String? { value as? String }
    var intValue: Int? { value as? Int }
    var doubleValue: Double? { value as? Double }
    var boolValue: Bool? { value as? Bool }
    var arrayValue: [Any]? { value as? [Any] }
    var dictValue: [String: Any]? { value as? [String: Any] }
    var isNull: Bool { value is NSNull }
}

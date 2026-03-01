/// Memory models for browsing and searching the Eidolon memory engine.

import Foundation

struct MemoryItem: Identifiable, Codable, Equatable {
    let id: String
    let type: String
    let content: String
    let importance: Double
    let createdAt: Date
    let tags: [String]

    init(
        id: String = UUID().uuidString,
        type: String,
        content: String,
        importance: Double = 0.5,
        createdAt: Date = Date(),
        tags: [String] = []
    ) {
        self.id = id
        self.type = type
        self.content = content
        self.importance = importance
        self.createdAt = createdAt
        self.tags = tags
    }

    /// SF Symbol name for the memory type.
    var typeIcon: String {
        switch type {
        case "fact":         return "doc.text"
        case "preference":   return "heart"
        case "decision":     return "checkmark.seal"
        case "episode":      return "clock"
        case "skill":        return "wrench.and.screwdriver"
        case "relationship": return "person.2"
        case "schema":       return "rectangle.3.group"
        default:             return "questionmark.circle"
        }
    }
}

struct MemorySearchResult: Codable {
    let items: [MemoryItem]
    let totalCount: Int
}

/// Unified logging utility using Apple's os.Logger framework.
/// Provides structured logging with per-module categories and
/// a thread-safe error ring buffer for phone-home reporting.

import Foundation
import os

// MARK: - LogEntry

/// Represents a captured log entry for error reporting.
struct LogEntry: Sendable {
    let timestamp: Date
    let category: String
    let level: LogLevel
    let message: String
}

/// Log severity levels matching os.Logger levels.
enum LogLevel: String, Sendable {
    case debug
    case info
    case warning
    case error
}

// MARK: - EidolonLogger

/// Centralized logging facade backed by Apple's unified logging system.
///
/// Uses `os.Logger` (subsystem `com.eidolon.app`) which:
/// - Works in release builds (unlike `print()`)
/// - Persists to the system log (viewable via Console.app)
/// - Supports level-based filtering automatically
///
/// Recent errors are stored in a thread-safe ring buffer for
/// phone-home / crash reporting.
enum EidolonLogger {

    // MARK: - Configuration

    private static let subsystem = "com.eidolon.app"
    private static let ringBufferCapacity = 100

    // MARK: - Ring Buffer

    /// Thread-safe ring buffer storing the most recent errors.
    private static let ringBuffer = RingBuffer(capacity: ringBufferCapacity)

    // MARK: - Logger Cache

    /// Cache of `os.Logger` instances keyed by category to avoid repeated allocation.
    private static let loggerCache = LoggerCache()

    // MARK: - Public API

    /// Log a debug-level message (stripped in release by the OS unless explicitly enabled).
    static func debug(category: String, message: String) {
        let logger = loggerCache.logger(for: category)
        logger.debug("\(message, privacy: .public)")
    }

    /// Log an informational message.
    static func info(category: String, message: String) {
        let logger = loggerCache.logger(for: category)
        logger.info("\(message, privacy: .public)")
    }

    /// Log a warning.
    static func warning(category: String, message: String) {
        let logger = loggerCache.logger(for: category)
        logger.warning("\(message, privacy: .public)")
    }

    /// Log an error and store it in the ring buffer for reporting.
    static func error(category: String, message: String) {
        let logger = loggerCache.logger(for: category)
        logger.error("\(message, privacy: .public)")

        let entry = LogEntry(
            timestamp: Date(),
            category: category,
            level: .error,
            message: message
        )
        ringBuffer.append(entry)
    }

    /// Retrieve the most recent error entries (up to `ringBufferCapacity`).
    static func getRecentErrors() -> [LogEntry] {
        ringBuffer.entries()
    }

    /// Clear all stored error entries.
    static func clearRecentErrors() {
        ringBuffer.clear()
    }
}

// MARK: - LoggerCache

/// Thread-safe cache for `os.Logger` instances.
private final class LoggerCache: @unchecked Sendable {
    private let lock = NSLock()
    private var cache: [String: os.Logger] = [:]

    func logger(for category: String) -> os.Logger {
        lock.lock()
        defer { lock.unlock() }

        if let existing = cache[category] {
            return existing
        }

        let logger = os.Logger(subsystem: "com.eidolon.app", category: category)
        cache[category] = logger
        return logger
    }
}

// MARK: - RingBuffer

/// Thread-safe fixed-capacity ring buffer for `LogEntry` values.
private final class RingBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer: [LogEntry]
    private let capacity: Int
    private var head: Int = 0
    private var count: Int = 0

    init(capacity: Int) {
        self.capacity = capacity
        self.buffer = []
        self.buffer.reserveCapacity(capacity)
    }

    func append(_ entry: LogEntry) {
        lock.lock()
        defer { lock.unlock() }

        if buffer.count < capacity {
            buffer.append(entry)
        } else {
            buffer[head] = entry
        }
        head = (head + 1) % capacity
        count = min(count + 1, capacity)
    }

    func entries() -> [LogEntry] {
        lock.lock()
        defer { lock.unlock() }

        guard count > 0 else { return [] }

        if buffer.count < capacity {
            return buffer
        }

        // Return in chronological order: oldest first
        let start = head % capacity
        return Array(buffer[start...]) + Array(buffer[..<start])
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        buffer.removeAll(keepingCapacity: true)
        head = 0
        count = 0
    }
}

import Darwin
import Foundation

public enum OverlayHelperController {
    private static let lock = NSLock()

    public static func ensureRunning() {
        lock.lock()
        defer { lock.unlock() }

        guard !isRunning() else {
            return
        }

        guard let helperURL = helperExecutableURL() else {
            return
        }

        let process = Process()
        process.executableURL = helperURL
        process.arguments = []
        process.environment = ProcessInfo.processInfo.environment.merging(
            ["CLAUDEX_COMPUTER_USE_OVERLAY_HELPER": "1"],
            uniquingKeysWith: { _, new in new }
        )

        let nullOutput = FileHandle.nullDevice
        process.standardInput = nil
        process.standardOutput = nullOutput
        process.standardError = nullOutput

        do {
            try process.run()
        } catch {
            return
        }
    }

    public static func isRunning() -> Bool {
        let pidFileURL = VirtualCursor.overlayPIDFileURL()
        guard
            let text = try? String(contentsOf: pidFileURL, encoding: .utf8),
            let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)),
            pid > 0
        else {
            return false
        }

        if kill(pid, 0) == 0 {
            return true
        }

        try? FileManager.default.removeItem(at: pidFileURL)
        return false
    }

    public static func writeCurrentPIDFile() {
        let pidFileURL = VirtualCursor.overlayPIDFileURL()
        try? String(getpid()).write(to: pidFileURL, atomically: true, encoding: .utf8)
    }

    public static func clearCurrentPIDFile() {
        let pidFileURL = VirtualCursor.overlayPIDFileURL()
        guard
            let text = try? String(contentsOf: pidFileURL, encoding: .utf8),
            let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)),
            pid == getpid()
        else {
            return
        }
        try? FileManager.default.removeItem(at: pidFileURL)
    }

    private static func helperExecutableURL() -> URL? {
        guard let currentExecutable = Bundle.main.executableURL else {
            return nil
        }
        let candidate = currentExecutable
            .deletingLastPathComponent()
            .appendingPathComponent("claudex-computer-use-overlay-helper", isDirectory: false)
        guard FileManager.default.isExecutableFile(atPath: candidate.path) else {
            return nil
        }
        return candidate
    }
}

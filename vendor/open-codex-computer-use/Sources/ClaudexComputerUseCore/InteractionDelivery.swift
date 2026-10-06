import AppKit
import Foundation

public enum InteractionDeliveryMode: String, Codable {
    case background
    case direct
}

public struct FrontmostAppState: Codable {
    public let pid: Int32?
    public let localizedName: String?
    public let bundleIdentifier: String?

    public init(app: NSRunningApplication?) {
        self.pid = app?.processIdentifier
        self.localizedName = app?.localizedName
        self.bundleIdentifier = app?.bundleIdentifier
    }
}

enum InteractionDelivery {
    static func frontmostAppState() -> FrontmostAppState {
        FrontmostAppState(app: NSWorkspace.shared.frontmostApplication)
    }

    @discardableResult
    static func perform<T>(
        targetPID: pid_t,
        mode: InteractionDeliveryMode,
        restoreFocus: Bool,
        activationDelay: TimeInterval = 0.12,
        restorationDelay: TimeInterval = 0.08,
        operation: () throws -> T
    ) throws -> (result: T, frontmostBefore: FrontmostAppState, frontmostAfter: FrontmostAppState) {
        let frontmostBefore = frontmostAppState()

        if mode == .direct {
            try activate(pid: targetPID)
            Thread.sleep(forTimeInterval: activationDelay)
        }

        let result = try operation()

        if restoreFocus,
           let previousPID = frontmostBefore.pid,
           previousPID != targetPID,
           let previousApp = NSRunningApplication(processIdentifier: previousPID) {
            _ = previousApp.activate(options: [.activateIgnoringOtherApps])
            Thread.sleep(forTimeInterval: restorationDelay)
        }

        let frontmostAfter = frontmostAppState()
        return (result, frontmostBefore, frontmostAfter)
    }

    static func activate(pid: pid_t) throws {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            throw ClaudexComputerUseCoreError.processNotFound(pid)
        }
        guard app.activate(options: [.activateIgnoringOtherApps]) else {
            throw ClaudexComputerUseCoreError.invalidArgument(
                "Failed to activate \(app.localizedName ?? "PID=\(pid)") for direct delivery."
            )
        }
    }
}

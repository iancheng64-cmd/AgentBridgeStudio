import AppKit
import Darwin
import Foundation

public enum DesktopSessionMode: String, Codable {
    case shared
    case exclusive
}

public struct DesktopSessionStatus: Codable {
    public let active: Bool
    public let sessionID: String?
    public let mode: DesktopSessionMode?
    public let acquiredAt: Date?
    public let frontmostPIDAtAcquire: Int32?
    public let frontmostAppAtAcquire: String?
    public let frontmostBundleIDAtAcquire: String?
    public let currentFrontmostPID: Int32?
    public let currentFrontmostApp: String?
    public let currentFrontmostBundleID: String?
    public let actionBudget: Int?
    public let actionsUsed: Int
    public let interrupted: Bool
    public let interruptionReason: String?
    public let cursorAtAcquire: CursorPosition?
    public let currentCursor: CursorPosition
    public let cursorMovedDistance: Double
    public let externalExclusiveLock: Bool
    public let lockPath: String?

    public init(
        active: Bool,
        sessionID: String?,
        mode: DesktopSessionMode?,
        acquiredAt: Date?,
        frontmostPIDAtAcquire: Int32?,
        frontmostAppAtAcquire: String?,
        frontmostBundleIDAtAcquire: String?,
        currentFrontmostPID: Int32?,
        currentFrontmostApp: String?,
        currentFrontmostBundleID: String?,
        actionBudget: Int?,
        actionsUsed: Int,
        interrupted: Bool,
        interruptionReason: String?,
        cursorAtAcquire: CursorPosition?,
        currentCursor: CursorPosition,
        cursorMovedDistance: Double,
        externalExclusiveLock: Bool,
        lockPath: String?
    ) {
        self.active = active
        self.sessionID = sessionID
        self.mode = mode
        self.acquiredAt = acquiredAt
        self.frontmostPIDAtAcquire = frontmostPIDAtAcquire
        self.frontmostAppAtAcquire = frontmostAppAtAcquire
        self.frontmostBundleIDAtAcquire = frontmostBundleIDAtAcquire
        self.currentFrontmostPID = currentFrontmostPID
        self.currentFrontmostApp = currentFrontmostApp
        self.currentFrontmostBundleID = currentFrontmostBundleID
        self.actionBudget = actionBudget
        self.actionsUsed = actionsUsed
        self.interrupted = interrupted
        self.interruptionReason = interruptionReason
        self.cursorAtAcquire = cursorAtAcquire
        self.currentCursor = currentCursor
        self.cursorMovedDistance = cursorMovedDistance
        self.externalExclusiveLock = externalExclusiveLock
        self.lockPath = lockPath
    }
}

public enum DesktopSessionManager {
    private static let directoryName = "claudex-computer-use"
    private struct State {
        let sessionID: String
        let mode: DesktopSessionMode
        let acquiredAt: Date
        let frontmostPIDAtAcquire: Int32?
        let frontmostAppAtAcquire: String?
        let frontmostBundleIDAtAcquire: String?
        let cursorAtAcquire: CursorPosition
        let actionBudget: Int?
        var actionsUsed: Int
        var interrupted: Bool
        var interruptionReason: String?
        let lockFileDescriptor: Int32
        let lockPath: String
    }

    private struct LockHandle {
        let fileDescriptor: Int32
        let path: String
    }

    private static let lock = NSLock()
    private static var state: State?

    public static func acquire(
        mode: DesktopSessionMode = .shared,
        actionBudget: Int? = nil
    ) throws -> DesktopSessionStatus {
        lock.lock()
        defer { lock.unlock() }

        if state != nil {
            releaseLockedState()
        }

        let handle = try acquireLock(mode: mode)
        let frontmost = NSWorkspace.shared.frontmostApplication
        let currentCursor = CursorPosition(NSEvent.mouseLocation)
        state = State(
            sessionID: UUID().uuidString,
            mode: mode,
            acquiredAt: Date(),
            frontmostPIDAtAcquire: frontmost?.processIdentifier,
            frontmostAppAtAcquire: frontmost?.localizedName,
            frontmostBundleIDAtAcquire: frontmost?.bundleIdentifier,
            cursorAtAcquire: currentCursor,
            actionBudget: actionBudget,
            actionsUsed: 0,
            interrupted: false,
            interruptionReason: nil,
            lockFileDescriptor: handle.fileDescriptor,
            lockPath: handle.path
        )
        return statusLocked()
    }

    @discardableResult
    public static func release() -> DesktopSessionStatus {
        lock.lock()
        defer { lock.unlock() }
        releaseLockedState()
        return statusLocked()
    }

    public static func status() -> DesktopSessionStatus {
        lock.lock()
        defer { lock.unlock() }
        return statusLocked()
    }

    public static func recordMutation(tool: String) throws {
        lock.lock()
        defer { lock.unlock() }

        guard var state else {
            let externalLock = externalExclusiveLockLocked()
            if externalLock.held {
                throw ClaudexComputerUseCoreError.desktopSessionConflict(
                    "Desktop session is exclusively locked by another Claudex Computer Use process. Release that session before \(tool)."
                )
            }
            return
        }

        if let actionBudget = state.actionBudget,
           state.actionsUsed >= actionBudget {
            throw ClaudexComputerUseCoreError.desktopSessionConflict(
                "Desktop session action budget exceeded (\(actionBudget)). Release or reacquire the desktop session."
            )
        }

        if state.mode == .exclusive {
            let evaluation = interruptionState(for: state)
            state.interrupted = evaluation.interrupted
            state.interruptionReason = evaluation.reason
            if state.interrupted {
                self.state = state
                throw ClaudexComputerUseCoreError.desktopSessionConflict(
                    "Desktop session interrupted before \(tool): \(evaluation.reason ?? "unknown reason")."
                )
            }
        }

        state.actionsUsed += 1
        self.state = state
    }

    private static func statusLocked() -> DesktopSessionStatus {
        let frontmost = NSWorkspace.shared.frontmostApplication
        let currentCursor = CursorPosition(NSEvent.mouseLocation)

        guard let state else {
            let externalLock = externalExclusiveLockLocked()
            return DesktopSessionStatus(
                active: false,
                sessionID: nil,
                mode: nil,
                acquiredAt: nil,
                frontmostPIDAtAcquire: nil,
                frontmostAppAtAcquire: nil,
                frontmostBundleIDAtAcquire: nil,
                currentFrontmostPID: frontmost?.processIdentifier,
                currentFrontmostApp: frontmost?.localizedName,
                currentFrontmostBundleID: frontmost?.bundleIdentifier,
                actionBudget: nil,
                actionsUsed: 0,
                interrupted: false,
                interruptionReason: nil,
                cursorAtAcquire: nil,
                currentCursor: currentCursor,
                cursorMovedDistance: 0,
                externalExclusiveLock: externalLock.held,
                lockPath: externalLock.path
            )
        }

        let evaluation = interruptionState(for: state)
        return DesktopSessionStatus(
            active: true,
            sessionID: state.sessionID,
            mode: state.mode,
            acquiredAt: state.acquiredAt,
            frontmostPIDAtAcquire: state.frontmostPIDAtAcquire,
            frontmostAppAtAcquire: state.frontmostAppAtAcquire,
            frontmostBundleIDAtAcquire: state.frontmostBundleIDAtAcquire,
            currentFrontmostPID: frontmost?.processIdentifier,
            currentFrontmostApp: frontmost?.localizedName,
            currentFrontmostBundleID: frontmost?.bundleIdentifier,
            actionBudget: state.actionBudget,
            actionsUsed: state.actionsUsed,
            interrupted: evaluation.interrupted,
            interruptionReason: evaluation.reason,
            cursorAtAcquire: state.cursorAtAcquire,
            currentCursor: currentCursor,
            cursorMovedDistance: cursorDistance(from: state.cursorAtAcquire, to: currentCursor),
            externalExclusiveLock: false,
            lockPath: state.lockPath
        )
    }

    private static func interruptionState(for state: State) -> (interrupted: Bool, reason: String?) {
        guard state.mode == .exclusive else {
            return (state.interrupted, state.interruptionReason)
        }

        let frontmost = NSWorkspace.shared.frontmostApplication
        if let acquiredPID = state.frontmostPIDAtAcquire,
           let currentPID = frontmost?.processIdentifier,
           currentPID != acquiredPID {
            return (true, "frontmost app changed from PID=\(acquiredPID) to PID=\(currentPID)")
        }

        let cursorDistance = cursorDistance(
            from: state.cursorAtAcquire,
            to: CursorPosition(NSEvent.mouseLocation)
        )
        if cursorDistance > 24 {
            return (true, "visible cursor moved by \(Int(cursorDistance))pt")
        }

        return (state.interrupted, state.interruptionReason)
    }

    private static func cursorDistance(from lhs: CursorPosition, to rhs: CursorPosition) -> Double {
        let dx = rhs.x - lhs.x
        let dy = rhs.y - lhs.y
        return (dx * dx + dy * dy).squareRoot()
    }

    private static func acquireLock(mode: DesktopSessionMode) throws -> LockHandle {
        let path = lockURL().path
        let fileDescriptor = try openLockFile(path: path)
        let operation = mode == .exclusive ? (LOCK_EX | LOCK_NB) : (LOCK_SH | LOCK_NB)
        if flock(fileDescriptor, operation) != 0 {
            let code = errno
            close(fileDescriptor)
            if code == EWOULDBLOCK {
                throw ClaudexComputerUseCoreError.desktopSessionConflict(
                    "Could not acquire a \(mode.rawValue) desktop session because another Claudex Computer Use process already holds the desktop lock."
                )
            }
            throw ClaudexComputerUseCoreError.desktopSessionConflict(
                "Failed to acquire the Claudex Computer Use desktop lock (errno \(code))."
            )
        }
        return LockHandle(fileDescriptor: fileDescriptor, path: path)
    }

    private static func releaseLockedState() {
        guard let state else {
            return
        }
        flock(state.lockFileDescriptor, LOCK_UN)
        close(state.lockFileDescriptor)
        self.state = nil
    }

    private static func externalExclusiveLockLocked() -> (held: Bool, path: String?) {
        let path = lockURL().path
        guard let fileDescriptor = try? openLockFile(path: path) else {
            return (false, path)
        }
        defer { close(fileDescriptor) }

        if flock(fileDescriptor, LOCK_SH | LOCK_NB) == 0 {
            flock(fileDescriptor, LOCK_UN)
            return (false, path)
        }

        if errno == EWOULDBLOCK {
            return (true, path)
        }

        return (false, path)
    }

    private static func openLockFile(path: String) throws -> Int32 {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let fileDescriptor = path.withCString { pointer in
            open(pointer, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        }
        guard fileDescriptor >= 0 else {
            throw ClaudexComputerUseCoreError.desktopSessionConflict(
                "Failed to open the Claudex Computer Use desktop lock file at \(path)."
            )
        }
        return fileDescriptor
    }

    private static func lockURL() -> URL {
        let cachesDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return cachesDirectory
            .appendingPathComponent(directoryName, isDirectory: true)
            .appendingPathComponent("desktop-session.lock", isDirectory: false)
    }
}

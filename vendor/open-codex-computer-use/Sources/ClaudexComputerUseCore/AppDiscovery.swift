import AppKit
import Foundation

public struct RunningAppInfo: Codable {
    public let pid: Int32
    public let localizedName: String?
    public let bundleIdentifier: String?
    public let activationPolicy: String
    public let isActive: Bool
    public let isHidden: Bool
    public let isFinishedLaunching: Bool

    public init(
        pid: Int32,
        localizedName: String?,
        bundleIdentifier: String?,
        activationPolicy: String,
        isActive: Bool,
        isHidden: Bool,
        isFinishedLaunching: Bool
    ) {
        self.pid = pid
        self.localizedName = localizedName
        self.bundleIdentifier = bundleIdentifier
        self.activationPolicy = activationPolicy
        self.isActive = isActive
        self.isHidden = isHidden
        self.isFinishedLaunching = isFinishedLaunching
    }
}

public enum AppDiscovery {
    public static func listRunningApps(includeBackground: Bool = false) -> [RunningAppInfo] {
        NSWorkspace.shared.runningApplications
            .filter { app in
                guard !app.isTerminated else {
                    return false
                }

                if includeBackground {
                    return true
                }

                return app.activationPolicy != .prohibited
            }
            .map { app in
                RunningAppInfo(
                    pid: app.processIdentifier,
                    localizedName: app.localizedName,
                    bundleIdentifier: app.bundleIdentifier,
                    activationPolicy: activationPolicyName(app.activationPolicy),
                    isActive: app.isActive,
                    isHidden: app.isHidden,
                    isFinishedLaunching: app.isFinishedLaunching
                )
            }
            .sorted { lhs, rhs in
                sortKey(lhs) < sortKey(rhs)
            }
    }

    private static func sortKey(_ app: RunningAppInfo) -> String {
        let name = app.localizedName ?? app.bundleIdentifier ?? ""
        return "\(name.lowercased())-\(app.pid)"
    }

    private static func activationPolicyName(_ policy: NSApplication.ActivationPolicy) -> String {
        switch policy {
        case .regular:
            return "regular"
        case .accessory:
            return "accessory"
        case .prohibited:
            return "prohibited"
        @unknown default:
            return "unknown"
        }
    }
}

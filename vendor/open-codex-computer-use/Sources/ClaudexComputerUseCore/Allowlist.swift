import AppKit
import Foundation

public struct AllowlistConfig: Codable {
    public var allowedBundleIDs: Set<String>
    public var deniedBundleIDs: Set<String>
    public var mode: AllowlistMode

    public init(
        allowedBundleIDs: Set<String> = [],
        deniedBundleIDs: Set<String> = [],
        mode: AllowlistMode = .allowAll
    ) {
        self.allowedBundleIDs = allowedBundleIDs
        self.deniedBundleIDs = deniedBundleIDs
        self.mode = mode
    }

    public static let permissive = AllowlistConfig(mode: .allowAll)
}

public enum AllowlistMode: String, Codable {
    /// All apps allowed unless explicitly denied.
    case allowAll
    /// Only explicitly allowed apps can be targeted.
    case allowlistOnly
}

public enum AllowlistDecision {
    case allowed
    case denied(reason: String)
}

public enum Allowlist {
    private static var config = AllowlistConfig.permissive
    private static let directoryName = "claudex-computer-use"

    public static func load(_ newConfig: AllowlistConfig) {
        config = newConfig
    }

    public static func currentConfig() -> AllowlistConfig {
        config
    }

    public static func check(pid: pid_t) -> AllowlistDecision {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            return .denied(reason: "No running app found for PID=\(pid).")
        }

        return check(bundleIdentifier: app.bundleIdentifier, appName: app.localizedName, pid: pid)
    }

    public static func check(
        bundleIdentifier: String?,
        appName: String?,
        pid: pid_t
    ) -> AllowlistDecision {
        let displayName = appName ?? bundleIdentifier ?? "PID=\(pid)"

        if let bundleID = bundleIdentifier {
            if config.deniedBundleIDs.contains(bundleID) {
                return .denied(reason: "\(displayName) (\(bundleID)) is explicitly denied.")
            }
        }

        switch config.mode {
        case .allowAll:
            return .allowed

        case .allowlistOnly:
            guard let bundleID = bundleIdentifier else {
                return .denied(reason: "\(displayName) has no bundle identifier and cannot be verified against the allowlist.")
            }

            if config.allowedBundleIDs.contains(bundleID) {
                return .allowed
            }

            return .denied(reason: "\(displayName) (\(bundleID)) is not in the allowlist.")
        }
    }

    public static func require(pid: pid_t) throws {
        let decision = check(pid: pid)
        switch decision {
        case .allowed:
            return
        case .denied(let reason):
            throw ClaudexComputerUseCoreError.appNotAllowed(reason)
        }
    }

    // MARK: - Config file I/O

    public static func loadFromFile(_ url: URL) throws -> AllowlistConfig {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(AllowlistConfig.self, from: data)
    }

    public static func saveToFile(_ config: AllowlistConfig, url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        try data.write(to: url)
    }

    public static func defaultConfigURL() -> URL {
        configURL(for: directoryName)
    }

    public static func loadFromDefaultLocation() {
        let url = defaultConfigURL()
        guard FileManager.default.fileExists(atPath: url.path) else {
            return
        }
        if let loaded = try? loadFromFile(url) {
            load(loaded)
        }
    }

    private static func configURL(for directoryName: String) -> URL {
        let configDir: URL
        if let xdgConfig = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"] {
            configDir = URL(fileURLWithPath: xdgConfig).appendingPathComponent(directoryName)
        } else {
            configDir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".config")
                .appendingPathComponent(directoryName)
        }
        return configDir.appendingPathComponent("allowlist.json")
    }
}

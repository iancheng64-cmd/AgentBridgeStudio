import AppKit
import Foundation

/// Resolves an app identifier (name, bundle ID, or PID string) to a running process.
public enum AppResolver {
    public struct ResolvedApp {
        public let pid: pid_t
        public let localizedName: String?
        public let bundleIdentifier: String?

        public init(pid: pid_t, localizedName: String?, bundleIdentifier: String?) {
            self.pid = pid
            self.localizedName = localizedName
            self.bundleIdentifier = bundleIdentifier
        }
    }

    /// Resolve an app identifier to a running process.
    /// Accepts: bundle ID (com.apple.Safari), localized name (Safari), or PID string ("1234").
    public static func resolve(_ identifier: String) throws -> ResolvedApp {
        let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw ClaudexComputerUseCoreError.invalidArgument("App identifier must not be empty.")
        }

        // Try as PID first
        if let pid = Int32(trimmed) {
            if let app = NSRunningApplication(processIdentifier: pid) {
                return ResolvedApp(
                    pid: pid,
                    localizedName: app.localizedName,
                    bundleIdentifier: app.bundleIdentifier
                )
            }
        }

        let candidates = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }

        // Try exact bundle ID match
        if let app = candidates.first(where: { $0.bundleIdentifier == trimmed }) {
            return resolvedApp(from: app)
        }

        if let app = bestFuzzyMatch(for: trimmed, candidates: candidates) {
            return resolvedApp(from: app)
        }

        throw ClaudexComputerUseCoreError.invalidArgument(
            "appNotFound(\"\(trimmed)\")"
        )
    }

    private static func resolvedApp(from app: NSRunningApplication) -> ResolvedApp {
        ResolvedApp(
            pid: app.processIdentifier,
            localizedName: app.localizedName,
            bundleIdentifier: app.bundleIdentifier
        )
    }

    private static func bestFuzzyMatch(
        for identifier: String,
        candidates: [NSRunningApplication]
    ) -> NSRunningApplication? {
        let lowered = identifier.lowercased()

        return candidates
            .compactMap { app -> (app: NSRunningApplication, matchScore: Int, preferenceScore: Int)? in
                guard let matchScore = matchScore(for: app, identifier: identifier, lowered: lowered) else {
                    return nil
                }

                return (app, matchScore, preferenceScore(for: app))
            }
            .sorted { lhs, rhs in
                if lhs.matchScore != rhs.matchScore {
                    return lhs.matchScore > rhs.matchScore
                }
                if lhs.preferenceScore != rhs.preferenceScore {
                    return lhs.preferenceScore > rhs.preferenceScore
                }
                return lhs.app.processIdentifier > rhs.app.processIdentifier
            }
            .first?
            .app
    }

    private static func matchScore(
        for app: NSRunningApplication,
        identifier: String,
        lowered: String
    ) -> Int? {
        let name = app.localizedName ?? ""
        let nameLowered = name.lowercased()
        let bundleID = app.bundleIdentifier ?? ""
        let bundleLowered = bundleID.lowercased()
        let bundleLeaf = bundleID.split(separator: ".").last.map(String.init) ?? ""
        let bundleLeafLowered = bundleLeaf.lowercased()

        if name == identifier {
            return 980
        }
        if nameLowered == lowered {
            return 970
        }
        if bundleLowered == lowered {
            return 960
        }
        if bundleLeafLowered == lowered {
            return 950
        }
        if bundleLeafLowered.contains(lowered) {
            return 930
        }
        if bundleLowered.contains(lowered) {
            return 920
        }
        if nameLowered.hasPrefix(lowered) {
            return 900
        }
        if nameLowered.localizedCaseInsensitiveContains(identifier) {
            return 820
        }
        if bundleLeafLowered.hasPrefix(lowered) {
            return 810
        }
        return nil
    }

    private static func preferenceScore(for app: NSRunningApplication) -> Int {
        var score = 0

        switch app.activationPolicy {
        case .regular:
            score += 300
        case .accessory:
            score += 150
        case .prohibited:
            score += 0
        @unknown default:
            score += 0
        }

        if app.isActive {
            score += 40
        }
        if !app.isHidden {
            score += 10
        }
        if app.isFinishedLaunching {
            score += 5
        }
        if isLikelyHelper(app) {
            score -= 120
        }

        return score
    }

    private static func isLikelyHelper(_ app: NSRunningApplication) -> Bool {
        let text = [
            app.localizedName ?? "",
            app.bundleIdentifier ?? ""
        ]
        .joined(separator: " ")
        .lowercased()

        let helperMarkers = [
            " helper",
            ".helper",
            "webcontent",
            "networking",
            "graphics and media",
            ".gpu",
            "renderer",
            "plugin",
            "platformsupport"
        ]

        return helperMarkers.contains { text.contains($0) }
    }
}

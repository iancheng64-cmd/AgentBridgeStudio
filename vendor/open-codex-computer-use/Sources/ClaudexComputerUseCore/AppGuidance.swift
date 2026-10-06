import AppKit
import Foundation

public enum AppFrameReliability: String, Codable {
    case high
    case medium
    case low
}

public struct AppGuidanceHint: Codable {
    public let profile: String
    public let summary: String
    public let recommendedStrategies: [String]
    public let knownLimitations: [String]
    public let confidence: String
    public let frameReliability: AppFrameReliability

    public init(
        profile: String,
        summary: String,
        recommendedStrategies: [String],
        knownLimitations: [String],
        confidence: String,
        frameReliability: AppFrameReliability
    ) {
        self.profile = profile
        self.summary = summary
        self.recommendedStrategies = recommendedStrategies
        self.knownLimitations = knownLimitations
        self.confidence = confidence
        self.frameReliability = frameReliability
    }
}

public enum AppGuidance {
    public static func guidance(
        bundleIdentifier: String?,
        localizedName: String?,
        snapshot: AppStateSnapshot? = nil
    ) -> AppGuidanceHint {
        let bundleID = bundleIdentifier?.lowercased() ?? ""
        let name = localizedName?.lowercased() ?? ""

        if isBrowser(bundleID: bundleID) {
            return AppGuidanceHint(
                profile: "browser",
                summary: "Browser UIs usually expose a rich AX tree. Prefer element_index clicks and direct value setting over raw coordinates.",
                recommendedStrategies: [
                    "Use element_index actions first for toolbar buttons, address bar, and page links.",
                    "Prefer press_key for global browser shortcuts like cmd+l, cmd+f, cmd+r, cmd+shift+[.",
                    "When the page AX tree is large, scroll by pages and re-snapshot after major jumps."
                ],
                knownLimitations: [
                    "Complex canvas apps and some cross-origin embedded content may expose incomplete AX nodes.",
                    "Browser page structure can change after navigation; snapshots should be refreshed aggressively."
                ],
                confidence: "high",
                frameReliability: .high
            )
        }

        if isFinder(bundleID: bundleID) {
            return AppGuidanceHint(
                profile: "finder",
                summary: "Finder generally has strong AX coverage. Navigation is most reliable through shortcuts and sidebar/tree elements.",
                recommendedStrategies: [
                    "Use cmd+shift+g to jump to a path when direct tree navigation is noisy.",
                    "Prefer sidebar / outline / row elements over coordinate clicks in content regions.",
                    "Re-snapshot after folder navigation because the visible file list refreshes asynchronously."
                ],
                knownLimitations: [
                    "Transient sheets and open/save panels can replace the main window AX tree."
                ],
                confidence: "high",
                frameReliability: .high
            )
        }

        if isJetBrains(bundleID: bundleID, name: name) {
            return AppGuidanceHint(
                profile: "jetbrains",
                summary: "JetBrains-based IDEs expose menus and dialogs well, but editor surfaces and custom panes can be sparse.",
                recommendedStrategies: [
                    "Prefer menus, dialogs, search panels, and keyboard shortcuts over editor-area coordinate clicks.",
                    "Use cmd+shift+a or dedicated search shortcuts to reach commands instead of traversing deep trees."
                ],
                knownLimitations: [
                    "Code editor canvases and tool windows may have weak AX fidelity.",
                    "Drag-and-drop interactions are best-effort."
                ],
                confidence: "medium",
                frameReliability: .medium
            )
        }

        if isElectronLike(bundleID: bundleID, name: name) {
            return AppGuidanceHint(
                profile: "electron",
                summary: "Electron and custom-rendered apps often expose shell chrome but not the full content surface.",
                recommendedStrategies: [
                    "Prefer menu items, keyboard shortcuts, and top-level navigation elements.",
                    "Use get_app_state frequently; only a subset of the UI may be visible in AX at once.",
                    "Prefer type_text with strategy=pasteboard when IME or custom input fields mangle unicode key injection.",
                    "Fallback to coordinate clicks only when the target frame is obvious and stable."
                ],
                knownLimitations: [
                    "Main content panes, chats, and editors may be missing from AX entirely.",
                    "Text injection can fail if the custom input field does not accept CGEvent unicode text."
                ],
                confidence: "medium",
                frameReliability: .low
            )
        }

        let settableCount = snapshot?.elements.filter(\.settable).count ?? 0
        let hasWebArea = snapshot?.elements.contains(where: { $0.role == "web area" }) ?? false

        return AppGuidanceHint(
            profile: hasWebArea ? "web-shell" : "native",
            summary: "This app appears to expose a mostly native Accessibility tree. Use element-index actions first and coordinates only as fallback.",
            recommendedStrategies: [
                "Start from get_app_state and target visible buttons, text fields, rows, and menus via element_index.",
                "Use set_value for editable controls when AXValue is settable (\(settableCount) settable element(s) in the current snapshot).",
                "Refresh the snapshot after each mutation to avoid stale paths."
            ],
            knownLimitations: hasWebArea ? [
                "Embedded web areas can be large and dynamic; element indices may churn after navigation."
            ] : [
                "Custom drawing regions can still hide controls from AX even in otherwise native apps."
            ],
            confidence: hasWebArea ? "medium" : "high",
            frameReliability: hasWebArea ? .medium : .high
        )
    }

    public static func render(_ guidance: AppGuidanceHint) -> String {
        var lines = ["<app_guidance>"]
        lines.append("Profile: \(guidance.profile)")
        lines.append("Summary: \(guidance.summary)")
        lines.append("Confidence: \(guidance.confidence)")
        lines.append("Frame reliability: \(guidance.frameReliability.rawValue)")
        if !guidance.recommendedStrategies.isEmpty {
            lines.append("Recommended:")
            for item in guidance.recommendedStrategies {
                lines.append("- \(item)")
            }
        }
        if !guidance.knownLimitations.isEmpty {
            lines.append("Limitations:")
            for item in guidance.knownLimitations {
                lines.append("- \(item)")
            }
        }
        lines.append("</app_guidance>")
        return lines.joined(separator: "\n")
    }

    private static func isBrowser(bundleID: String) -> Bool {
        bundleID.hasPrefix("com.apple.safari")
            || bundleID == "com.google.chrome"
            || bundleID == "com.microsoft.edgemac"
            || bundleID == "org.mozilla.firefox"
            || bundleID == "com.brave.browser"
    }

    private static func isFinder(bundleID: String) -> Bool {
        bundleID == "com.apple.finder"
    }

    private static func isJetBrains(bundleID: String, name: String) -> Bool {
        bundleID.contains("jetbrains")
            || name.contains("android studio")
            || name.contains("intellij")
            || name.contains("pycharm")
            || name.contains("webstorm")
    }

    private static func isElectronLike(bundleID: String, name: String) -> Bool {
        let markers = [
            "slack",
            "discord",
            "notion",
            "flue",
            "wechat",
            "wework",
            "feishu",
            "lark",
            "codebuddy"
        ]
        return markers.contains(where: { bundleID.contains($0) || name.contains($0) })
    }
}

import AppKit
import Foundation

/// Renders Claudex Computer Use app state into Codex CUA-compatible text envelopes.
public enum CodexCompat {
    public static let cuaVersion = ClaudexComputerUseVersion.current

    // MARK: - Full envelope (get_app_state / post-action state)

    /// Render the full Codex-style envelope: banner + app_specific_instructions + app_state + focused hint.
    public static func renderEnvelope(
        snapshot: AppStateSnapshot,
        guidance: AppGuidanceHint,
        focusedElementIndex: Int? = nil
    ) -> String {
        var parts: [String] = []

        // Banner
        parts.append("Computer Use state (CUA App Version: \(cuaVersion))")

        // App-specific instructions
        let instructions = renderAppSpecificInstructions(guidance: guidance)
        if !instructions.isEmpty {
            parts.append(instructions)
        }

        // App state tree
        parts.append(renderAppStateTree(snapshot: snapshot))

        // Focused element hint
        if let idx = focusedElementIndex,
           let element = snapshot.elements.first(where: { $0.index == idx }) {
            let role = element.role ?? "element"
            let title = element.title.map { " \($0)" } ?? ""
            parts.append("The focused UI element is \(idx) \(role)\(title).")
        }

        return parts.joined(separator: "\n")
    }

    // MARK: - App-specific instructions (Codex style)

    public static func renderAppSpecificInstructions(guidance: AppGuidanceHint) -> String {
        if guidance.profile == "browser" {
            return """
            <app_specific_instructions>
            ## Browser Computer Use

            When navigating to a new website or starting a separate web task, prefer opening a new tab instead of reusing the current tab; reuse the current tab only when the user explicitly asks to continue there or when the current page is clearly the right place to continue the existing workflow.

            \(renderGuidanceBody(guidance))
            </app_specific_instructions>
            """
        }

        if guidance.recommendedStrategies.isEmpty && guidance.knownLimitations.isEmpty {
            return ""
        }

        return """
        <app_specific_instructions>
        \(renderGuidanceBody(guidance))
        </app_specific_instructions>
        """
    }

    private static func renderGuidanceBody(_ guidance: AppGuidanceHint) -> String {
        var lines: [String] = []
        for item in guidance.recommendedStrategies {
            lines.append("- \(item)")
        }
        if !guidance.knownLimitations.isEmpty {
            lines.append("")
            lines.append("Limitations:")
            for item in guidance.knownLimitations {
                lines.append("- \(item)")
            }
        }
        return lines.joined(separator: "\n")
    }

    // MARK: - App state tree (Codex style)

    public static func renderAppStateTree(snapshot: AppStateSnapshot) -> String {
        // Reuse the formatted tree from AppStateService but wrap it if not already wrapped
        // The formatted tree from AppStateService already has <app_state> tags
        // This is just a pass-through since AppState.swift already generates the right format
        return snapshot.formattedTree ?? "<app_state>\nApp=\(snapshot.bundleIdentifier ?? snapshot.app) (pid \(snapshot.pid))\n</app_state>"
    }

    // MARK: - Stale / interference warnings

    public static func renderStaleWarning(appName: String) -> String {
        "The user changed '\(appName)'. Re-query the latest state with `get_app_state` before sending more actions."
    }

    // MARK: - Error mapping

    public static func mapErrorToCodexStyle(_ error: Error) -> String {
        let message = error.localizedDescription

        if message.contains("windowNotFound") || message.contains("no captureable window") || message.contains("Could not find") {
            return "Apple event error -10005: noWindowsAvailable"
        }
        if message.contains("timeout") || message.contains("Timeout") {
            return "Apple event error -10005: timeoutReached"
        }
        if message.contains("frame") && (message.contains("not expose") || message.contains("nil")) {
            return "Apple event error -10005: elementHasNoFrame"
        }
        if message.contains("appNotFound") || message.contains("No running app") {
            return "appNotFound(\"\(extractAppName(from: message))\")"
        }
        if message.contains("Re-query the latest state") {
            return message // Already in Codex format
        }
        if message.contains("notImplemented") || message.contains("AXError") {
            return "Accessibility error: AXError.notImplemented"
        }

        return message
    }

    private static func extractAppName(from message: String) -> String {
        // Try to extract app name from error messages like "appNotFound("Safari")"
        if let start = message.range(of: "\""), let end = message.range(of: "\"", range: start.upperBound..<message.endIndex) {
            return String(message[start.upperBound..<end.lowerBound])
        }
        return "unknown"
    }

    // MARK: - list_apps rich text

    public static func renderAppList(_ apps: [RunningAppInfo]) -> String {
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"

        return apps.map { app in
            let name = app.localizedName ?? "(unnamed)"
            let bundleID = app.bundleIdentifier ?? "-"
            var parts = ["running"]
            if app.isActive { parts.append("active") }

            // Try to get launch date as a proxy for "last-used"
            if let nsApp = NSRunningApplication(processIdentifier: app.pid),
               let launchDate = nsApp.launchDate {
                parts.append("launched=\(dateFormatter.string(from: launchDate))")
            }

            return "\(name) — \(bundleID) [\(parts.joined(separator: ", "))]"
        }.joined(separator: "\n")
    }

    // MARK: - Focused element detection

    /// Find the snapshot element index that corresponds to the currently focused AX element.
    public static func detectFocusedElementIndex(
        pid: pid_t,
        snapshot: AppStateSnapshot
    ) -> Int? {
        let appElement = AXUIElementCreateApplication(pid)
        guard let focusedElement = focusedUIElement(of: appElement) else {
            return nil
        }

        // Try to match by role + title + frame
        let focusedRole = stringAttr(kAXRoleAttribute as CFString, of: focusedElement)
        let focusedTitle = stringAttr(kAXTitleAttribute as CFString, of: focusedElement)
        let focusedFrame = elementFrame(of: focusedElement)

        for element in snapshot.elements {
            // Match by frame first (most specific)
            if let ef = element.frame, let ff = focusedFrame,
               abs(ef.x - ff.x) < 2 && abs(ef.y - ff.y) < 2 &&
               abs(ef.width - ff.width) < 2 && abs(ef.height - ff.height) < 2 {
                if element.role == friendlyRole(focusedRole) || focusedRole == nil {
                    return element.index
                }
            }
        }

        // Fallback: match by role + title
        if let role = friendlyRole(focusedRole) {
            for element in snapshot.elements {
                if element.role == role && element.title == focusedTitle && focusedTitle != nil {
                    return element.index
                }
            }
        }

        return nil
    }

    private static func focusedUIElement(of appElement: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &value)
        guard error == .success else { return nil }
        let cfValue = value as CFTypeRef
        guard CFGetTypeID(cfValue) == AXUIElementGetTypeID() else { return nil }
        return (cfValue as! AXUIElement)
    }

    private static func stringAttr(_ attr: CFString, of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attr, &value)
        guard error == .success else { return nil }
        if let str = value as? String {
            let t = str.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        return nil
    }

    private static func elementFrame(of element: AXUIElement) -> ScreenRect? {
        guard let posValue = rawAttr(kAXPositionAttribute as CFString, of: element),
              let sizeValue = rawAttr(kAXSizeAttribute as CFString, of: element)
        else { return nil }
        let pos = posValue as! AXValue
        let sz = sizeValue as! AXValue
        guard AXValueGetType(pos) == .cgPoint, AXValueGetType(sz) == .cgSize else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(pos, .cgPoint, &point), AXValueGetValue(sz, .cgSize, &size) else { return nil }
        return ScreenRect(x: point.x, y: point.y, width: size.width, height: size.height)
    }

    private static func rawAttr(_ attr: CFString, of element: AXUIElement) -> Any? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attr, &value)
        guard error == .success else { return nil }
        return value
    }

    private static func friendlyRole(_ axRole: String?) -> String? {
        guard let role = axRole else { return nil }
        switch role {
        case "AXTextField": return "text field"
        case "AXTextArea": return "text area"
        case "AXButton": return "button"
        case "AXStaticText": return "text"
        case "AXLink": return "link"
        case "AXGroup": return "container"
        case "AXWindow": return "window"
        default:
            return role.hasPrefix("AX") ? String(role.dropFirst(2)).lowercased() : role.lowercased()
        }
    }
}

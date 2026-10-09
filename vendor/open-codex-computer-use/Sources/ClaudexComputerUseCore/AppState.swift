import AppKit
import ApplicationServices
import Foundation

// MARK: - Snapshot data model

public struct AppStateElement: Codable {
    public let index: Int
    public let depth: Int
    public let role: String?
    public let title: String?
    public let value: String?
    public let elementDescription: String?
    public let identifier: String?
    public let enabled: Bool?
    public let settable: Bool
    public let actions: [String]
    public let frame: ScreenRect?

    // Internal locator for resolving this element later
    public let windowIndex: Int
    public let path: [Int]
}

public struct AppStateSnapshot: Codable {
    public let app: String
    public let bundleIdentifier: String?
    public let pid: Int32
    public let revision: String
    public let timestamp: Date
    public let windowTitle: String?
    public let elements: [AppStateElement]
    public let elementCount: Int
    /// Pre-rendered Codex-style `<app_state>` tree text. Not serialized to JSON by default.
    public var formattedTree: String?

    enum CodingKeys: String, CodingKey {
        case app, bundleIdentifier, pid, revision, timestamp, windowTitle, elements, elementCount
    }
}

public struct AppStateResult {
    public let snapshot: AppStateSnapshot
    public let screenshot: CapturedWindowImage?
    public let formattedTree: String
    public let elementRefs: [Int: AXUIElement]
}

// MARK: - Session manager

public final class AppStateSession {
    private var currentSnapshots: [Int32: AppStateSnapshot] = [:]
    private var elementRefs: [Int32: [Int: AXUIElement]] = [:]

    public init() {}

    public func snapshot(for pid: pid_t) -> AppStateSnapshot? {
        currentSnapshots[pid]
    }

    public func store(_ snapshot: AppStateSnapshot, elementRefs refs: [Int: AXUIElement] = [:]) {
        currentSnapshots[snapshot.pid] = snapshot
        elementRefs[snapshot.pid] = refs
    }

    public func invalidate(pid: pid_t) {
        currentSnapshots.removeValue(forKey: pid)
        elementRefs.removeValue(forKey: pid)
    }

    public func invalidateAll() {
        currentSnapshots.removeAll()
        elementRefs.removeAll()
    }

    public func isStale(pid: pid_t) -> Bool {
        currentSnapshots[pid] == nil
    }

    public func requireActiveSnapshot(pid: pid_t, appName: String) throws {
        guard currentSnapshots[pid] != nil else {
            throw ClaudexComputerUseCoreError.staleSnapshot(appName: appName)
        }
    }

    public enum ResolvedElement {
        case directRef(AXUIElement, element: AppStateElement)
        case locator(windowIndex: Int, path: [Int], element: AppStateElement)
    }

    /// Resolve a flat element index. Returns either a direct AXUIElement ref or (windowIndex, path).
    public func resolveElementIndex(pid: pid_t, elementIndex: Int) throws -> ResolvedElement {
        guard let snap = currentSnapshots[pid] else {
            let appName = NSRunningApplication(processIdentifier: pid)?.localizedName
                ?? NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
                ?? "PID=\(pid)"
            throw ClaudexComputerUseCoreError.staleSnapshot(appName: appName)
        }
        guard let element = snap.elements.first(where: { $0.index == elementIndex }) else {
            throw ClaudexComputerUseCoreError.invalidArgument(
                "Element index \(elementIndex) not found in snapshot (has \(snap.elementCount) elements)."
            )
        }
        if let ref = elementRefs[pid]?[elementIndex] {
            return .directRef(ref, element: element)
        }
        return .locator(windowIndex: element.windowIndex, path: element.path, element: element)
    }
}

// MARK: - Snapshot builder

public enum AppStateService {
    private static let maxDepth = 12
    private static let maxNodes = 3000

    public static func getAppState(
        pid: pid_t,
        includeScreenshot: Bool = true,
        screenshotScale: Double = 0.5
    ) throws -> AppStateResult {
        guard AXIsProcessTrusted() else {
            throw ClaudexComputerUseCoreError.missingAccessibilityPermission
        }

        let app = try requireRunningApp(pid: pid)
        let appElement = AXUIElementCreateApplication(pid)

        // Build flat element list
        var elements: [AppStateElement] = []
        var counter = 0
        let windows = windowElements(of: appElement)

        // Also collect from focused window if windows array is empty
        var windowTargets: [(index: Int, element: AXUIElement)] = windows.enumerated().map { ($0.offset, $0.element) }
        if windowTargets.isEmpty {
            if let focused = elementAttribute(kAXFocusedWindowAttribute as CFString, of: appElement) {
                windowTargets = [(0, focused)]
            }
        }

        var primaryWindowTitle: String?

        for (windowIndex, windowElement) in windowTargets {
            if windowIndex == 0 {
                primaryWindowTitle = stringAttribute(kAXTitleAttribute as CFString, of: windowElement)
            }
            traverseElement(
                windowElement,
                windowIndex: windowIndex,
                path: [],
                depth: 0,
                counter: &counter,
                elements: &elements
            )
            if counter >= maxNodes {
                break
            }
        }

        // Also add menu bar items, storing direct refs for round-trip
        var directRefs: [Int: AXUIElement] = [:]
        if let menuBar = elementAttribute(kAXMenuBarAttribute as CFString, of: appElement) {
            let menuChildren = childElements(of: menuBar)
            for (i, menuItem) in menuChildren.enumerated() {
                let idx = counter
                let info = snapshotElement(
                    menuItem,
                    index: idx,
                    windowIndex: -1, // sentinel for menu bar
                    path: [i],
                    depth: 0
                )
                elements.append(info)
                directRefs[idx] = menuItem
                counter += 1
                if counter >= maxNodes { break }
            }
        }

        let revision = UUID().uuidString.prefix(8).lowercased()
        // Format tree text like Codex
        let formatted = formatTree(
            app: app,
            windowTitle: primaryWindowTitle,
            elements: elements
        )

        var snapshot = AppStateSnapshot(
            app: app.localizedName ?? app.bundleIdentifier ?? "PID=\(pid)",
            bundleIdentifier: app.bundleIdentifier,
            pid: pid,
            revision: String(revision),
            timestamp: Date(),
            windowTitle: primaryWindowTitle,
            elements: elements,
            elementCount: elements.count
        )
        snapshot.formattedTree = formatted

        // Screenshot
        var screenshot: CapturedWindowImage? = nil
        if includeScreenshot {
            screenshot = try? WindowCapture.captureWindow(
                pid: pid,
                scale: screenshotScale
            )
        }

        return AppStateResult(
            snapshot: snapshot,
            screenshot: screenshot,
            formattedTree: formatted,
            elementRefs: directRefs
        )
    }

    // MARK: - Tree traversal

    private static func traverseElement(
        _ element: AXUIElement,
        windowIndex: Int,
        path: [Int],
        depth: Int,
        counter: inout Int,
        elements: inout [AppStateElement]
    ) {
        guard counter < maxNodes else { return }
        guard depth <= maxDepth else { return }

        let info = snapshotElement(element, index: counter, windowIndex: windowIndex, path: path, depth: depth)
        elements.append(info)
        counter += 1

        let children = childElements(of: element)
        for (i, child) in children.enumerated() {
            var childPath = path
            childPath.append(i)
            traverseElement(
                child,
                windowIndex: windowIndex,
                path: childPath,
                depth: depth + 1,
                counter: &counter,
                elements: &elements
            )
            if counter >= maxNodes { break }
        }
    }

    private static func snapshotElement(
        _ element: AXUIElement,
        index: Int,
        windowIndex: Int,
        path: [Int],
        depth: Int
    ) -> AppStateElement {
        let role = stringAttribute(kAXRoleAttribute as CFString, of: element)
        let subrole = stringAttribute(kAXSubroleAttribute as CFString, of: element)
        let title = stringAttribute(kAXTitleAttribute as CFString, of: element)
        let value = valueString(of: element)
        let desc = stringAttribute(kAXDescriptionAttribute as CFString, of: element)
        let ident = stringAttribute(kAXIdentifierAttribute as CFString, of: element)
        let enabled = boolAttribute(kAXEnabledAttribute as CFString, of: element)
        let settable = isAttributeSettable(kAXValueAttribute as CFString, of: element)
        let actions = actionNames(of: element)
        let frame = elementFrame(of: element)

        return AppStateElement(
            index: index,
            depth: depth,
            role: friendlyRole(role: role, subrole: subrole),
            title: title,
            value: value,
            elementDescription: desc,
            identifier: ident,
            enabled: enabled,
            settable: settable,
            actions: actions,
            frame: frame,
            windowIndex: windowIndex,
            path: path
        )
    }

    // MARK: - Format tree for model consumption

    private static func formatTree(
        app: NSRunningApplication,
        windowTitle: String?,
        elements: [AppStateElement]
    ) -> String {
        var lines: [String] = []
        let appName = app.localizedName ?? app.bundleIdentifier ?? "unknown"
        let winTitle = windowTitle ?? "(untitled)"

        lines.append("App=\(app.bundleIdentifier ?? appName) (pid \(app.processIdentifier))")
        lines.append("Window: \"\(winTitle)\", App: \(appName).")

        for element in elements {
            let indent = String(repeating: "\t", count: element.depth + 1)
            var desc = "\(element.index) "

            // Role
            desc += element.role ?? "element"

            // Title
            if let title = element.title, !title.isEmpty {
                desc += " \(title)"
            }

            // Value
            if let value = element.value, !value.isEmpty {
                let truncated = value.count > 60 ? String(value.prefix(57)) + "..." : value
                if element.settable {
                    desc += " (settable) \(truncated)"
                } else {
                    desc += " Value: \(truncated)"
                }
            }

            // Description
            if let d = element.elementDescription, !d.isEmpty {
                desc += " Description: \(d)"
            }

            // Identifier
            if let id = element.identifier, !id.isEmpty {
                desc += " ID: \(id)"
            }

            // Enabled
            if element.enabled == false {
                desc += " (disabled)"
            }

            // Secondary actions (non-AXPress)
            let secondaryActions = element.actions.filter { $0 != "AXPress" }
            if !secondaryActions.isEmpty {
                let names = secondaryActions.map { friendlyActionName($0) }
                desc += " Secondary Actions: \(names.joined(separator: ", "))"
            }

            lines.append(indent + desc)
        }

        return "<app_state>\n" + lines.joined(separator: "\n") + "\n</app_state>"
    }

    // MARK: - Friendly names

    private static func friendlyRole(role: String?, subrole: String?) -> String? {
        guard let role else { return nil }
        var name: String
        switch role {
        case "AXWindow": name = "window"
        case "AXButton": name = "button"
        case "AXStaticText": name = "text"
        case "AXTextField": name = "text field"
        case "AXTextArea": name = "text area"
        case "AXCheckBox": name = "checkbox"
        case "AXRadioButton": name = "radio button"
        case "AXSlider": name = "slider"
        case "AXScrollArea": name = "scroll area"
        case "AXScrollBar": name = "scrollbar"
        case "AXTable": name = "table"
        case "AXRow": name = "row"
        case "AXColumn": name = "column"
        case "AXCell": name = "cell"
        case "AXLink": name = "link"
        case "AXImage": name = "image"
        case "AXGroup": name = "container"
        case "AXToolbar": name = "toolbar"
        case "AXMenuBar": name = "menu bar"
        case "AXMenu": name = "menu"
        case "AXMenuItem": name = "menu item"
        case "AXPopUpButton": name = "popup button"
        case "AXComboBox": name = "combo box"
        case "AXList": name = "list"
        case "AXOutline": name = "outline"
        case "AXDisclosureTriangle": name = "disclosure triangle"
        case "AXTabGroup": name = "tab group"
        case "AXSplitGroup": name = "split group"
        case "AXWebArea": name = "web area"
        default:
            name = role.hasPrefix("AX") ? String(role.dropFirst(2)).lowercased() : role.lowercased()
        }

        // Subrole refinements
        if let subrole {
            switch subrole {
            case "AXStandardWindow": name = "standard window"
            case "AXCloseButton": name = "close button"
            case "AXMinimizeButton": name = "minimize button"
            case "AXZoomButton": name = "zoom button"
            case "AXFullScreenButton": name = "fullscreen button"
            case "AXSearchField": name = "search text field"
            case "AXSecureTextField": name = "secure text field"
            default: break
            }
        }

        return name
    }

    private static func friendlyActionName(_ action: String) -> String {
        switch action {
        case "AXPress": return "Press"
        case "AXCancel": return "Cancel"
        case "AXRaise": return "Raise"
        case "AXShowMenu": return "Show Menu"
        case "AXPick": return "Pick"
        case "AXConfirm": return "Confirm"
        case "AXIncrement": return "Increment"
        case "AXDecrement": return "Decrement"
        case "AXScrollToVisible": return "Scroll To Visible"
        case "AXScrollUpByPage": return "Scroll Up"
        case "AXScrollDownByPage": return "Scroll Down"
        case "AXScrollLeftByPage": return "Scroll Left"
        case "AXScrollRightByPage": return "Scroll Right"
        case "AXZoomWindow": return "Zoom Window"
        default:
            return action.hasPrefix("AX") ? String(action.dropFirst(2)) : action
        }
    }

    // MARK: - AX helpers

    private static func requireRunningApp(pid: pid_t) throws -> NSRunningApplication {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            throw ClaudexComputerUseCoreError.processNotFound(pid)
        }
        return app
    }

    private static func windowElements(of appElement: AXUIElement) -> [AXUIElement] {
        arrayOfElements(kAXWindowsAttribute as CFString, of: appElement)
    }

    private static func childElements(of element: AXUIElement) -> [AXUIElement] {
        arrayOfElements(kAXChildrenAttribute as CFString, of: element)
    }

    private static func arrayOfElements(_ attribute: CFString, of element: AXUIElement) -> [AXUIElement] {
        guard let value = rawAttribute(attribute, of: element) else { return [] }
        return (value as? [AXUIElement]) ?? []
    }

    private static func elementAttribute(_ attribute: CFString, of element: AXUIElement) -> AXUIElement? {
        guard let value = rawAttribute(attribute, of: element) else { return nil }
        let cfValue = value as CFTypeRef
        guard CFGetTypeID(cfValue) == AXUIElementGetTypeID() else { return nil }
        return (cfValue as! AXUIElement)
    }

    private static func stringAttribute(_ attribute: CFString, of element: AXUIElement) -> String? {
        guard let value = rawAttribute(attribute, of: element) else { return nil }
        return stringify(value)
    }

    private static func boolAttribute(_ attribute: CFString, of element: AXUIElement) -> Bool? {
        guard let value = rawAttribute(attribute, of: element) else { return nil }
        switch value {
        case let bool as Bool: return bool
        case let number as NSNumber: return number.boolValue
        default: return nil
        }
    }

    private static func isAttributeSettable(_ attribute: CFString, of element: AXUIElement) -> Bool {
        var settable = DarwinBoolean(false)
        let error = AXUIElementIsAttributeSettable(element, attribute, &settable)
        return error == .success && settable.boolValue
    }

    private static func actionNames(of element: AXUIElement) -> [String] {
        var value: CFArray?
        let error = AXUIElementCopyActionNames(element, &value)
        guard error == .success else { return [] }
        return (value as? [String]) ?? []
    }

    private static func elementFrame(of element: AXUIElement) -> ScreenRect? {
        guard
            let posValue = rawAttribute(kAXPositionAttribute as CFString, of: element),
            let sizeValue = rawAttribute(kAXSizeAttribute as CFString, of: element)
        else { return nil }

        let pos = posValue as! AXValue
        let sz = sizeValue as! AXValue
        guard AXValueGetType(pos) == .cgPoint, AXValueGetType(sz) == .cgSize else { return nil }

        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(pos, .cgPoint, &point), AXValueGetValue(sz, .cgSize, &size) else { return nil }

        return ScreenRect(x: point.x, y: point.y, width: size.width, height: size.height)
    }

    private static func valueString(of element: AXUIElement) -> String? {
        guard let value = rawAttribute(kAXValueAttribute as CFString, of: element) else { return nil }
        return stringify(value)
    }

    private static func rawAttribute(_ attribute: CFString, of element: AXUIElement) -> Any? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard error == .success else { return nil }
        return value
    }

    private static func stringify(_ value: Any) -> String? {
        switch value {
        case let string as String:
            let t = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        case let attrStr as NSAttributedString:
            let t = attrStr.string.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        case let number as NSNumber:
            return number.stringValue
        case let url as URL:
            return url.absoluteString
        default:
            let rendered = String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
            return rendered.isEmpty ? nil : rendered
        }
    }
}

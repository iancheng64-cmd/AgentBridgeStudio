import AppKit
import ApplicationServices
import Foundation

public struct UIElementInfo: Codable {
    public let pid: Int32
    public let appName: String?
    public let windowIndex: Int
    public let windowTitle: String?
    public let path: [Int]
    public let role: String?
    public let subrole: String?
    public let title: String?
    public let value: String?
    public let elementDescription: String?
    public let identifier: String?
    public let frame: ScreenRect?
    public let enabled: Bool?
    public let actions: [String]

    public init(
        pid: Int32,
        appName: String?,
        windowIndex: Int,
        windowTitle: String?,
        path: [Int],
        role: String?,
        subrole: String?,
        title: String?,
        value: String?,
        elementDescription: String?,
        identifier: String?,
        frame: ScreenRect?,
        enabled: Bool?,
        actions: [String]
    ) {
        self.pid = pid
        self.appName = appName
        self.windowIndex = windowIndex
        self.windowTitle = windowTitle
        self.path = path
        self.role = role
        self.subrole = subrole
        self.title = title
        self.value = value
        self.elementDescription = elementDescription
        self.identifier = identifier
        self.frame = frame
        self.enabled = enabled
        self.actions = actions
    }
}

public struct UIElementQueryResult: Codable {
    public let pid: Int32
    public let appName: String?
    public let searchedWindowCount: Int
    public let scannedElementCount: Int
    public let matches: [UIElementInfo]

    public init(
        pid: Int32,
        appName: String?,
        searchedWindowCount: Int,
        scannedElementCount: Int,
        matches: [UIElementInfo]
    ) {
        self.pid = pid
        self.appName = appName
        self.searchedWindowCount = searchedWindowCount
        self.scannedElementCount = scannedElementCount
        self.matches = matches
    }
}

public struct UIElementPressResult: Codable {
    public let pid: Int32
    public let appName: String?
    public let windowIndex: Int
    public let path: [Int]
    public let role: String?
    public let title: String?
    public let action: String

    public init(
        pid: Int32,
        appName: String?,
        windowIndex: Int,
        path: [Int],
        role: String?,
        title: String?,
        action: String
    ) {
        self.pid = pid
        self.appName = appName
        self.windowIndex = windowIndex
        self.path = path
        self.role = role
        self.title = title
        self.action = action
    }
}

public enum UIElementValueInput {
    case string(String)
    case number(Double)
    case bool(Bool)

    public var valueType: String {
        switch self {
        case .string:
            return "string"
        case .number:
            return "number"
        case .bool:
            return "bool"
        }
    }

    public var displayValue: String {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return String(value)
        case .bool(let value):
            return value ? "true" : "false"
        }
    }

    fileprivate var axValue: CFTypeRef {
        switch self {
        case .string(let value):
            return value as NSString
        case .number(let value):
            return NSNumber(value: value)
        case .bool(let value):
            return NSNumber(value: value)
        }
    }
}

public struct UIElementSetValueResult: Codable {
    public let pid: Int32
    public let appName: String?
    public let windowIndex: Int
    public let path: [Int]
    public let role: String?
    public let title: String?
    public let valueType: String
    public let requestedValue: String
    public let previousValue: String?
    public let resultingValue: String?

    public init(
        pid: Int32,
        appName: String?,
        windowIndex: Int,
        path: [Int],
        role: String?,
        title: String?,
        valueType: String,
        requestedValue: String,
        previousValue: String?,
        resultingValue: String?
    ) {
        self.pid = pid
        self.appName = appName
        self.windowIndex = windowIndex
        self.path = path
        self.role = role
        self.title = title
        self.valueType = valueType
        self.requestedValue = requestedValue
        self.previousValue = previousValue
        self.resultingValue = resultingValue
    }
}

public enum UIElementService {
    private struct Query {
        let role: String?
        let text: String?
        let title: String?
        let value: String?
        let elementDescription: String?
        let maxResults: Int
        let maxDepth: Int
        let maxNodes: Int

        var hasAnyFilter: Bool {
            role != nil || text != nil || title != nil || value != nil || elementDescription != nil
        }

        func matches(_ element: UIElementInfo) -> Bool {
            if let role, normalizeAXName(element.role) != role {
                return false
            }
            if let text, !matchesText(text, element: element) {
                return false
            }
            if let title, !containsCaseInsensitive(haystack: element.title, needle: title) {
                return false
            }
            if let value, !containsCaseInsensitive(haystack: element.value, needle: value) {
                return false
            }
            if let elementDescription, !containsCaseInsensitive(haystack: element.elementDescription, needle: elementDescription) {
                return false
            }
            return true
        }
    }

    private struct SearchState {
        var scannedElementCount = 0
        var matches: [UIElementInfo] = []
    }

    public static func findUIElements(
        pid: pid_t,
        role: String? = nil,
        text: String? = nil,
        title: String? = nil,
        value: String? = nil,
        elementDescription: String? = nil,
        maxResults: Int = 10,
        searchAllWindows: Bool = true
    ) throws -> UIElementQueryResult {
        let app = try requireRunningApp(pid: pid)
        let appElement = try requireApplicationElement(pid: pid)
        let query = try makeQuery(
            role: role,
            text: text,
            title: title,
            value: value,
            elementDescription: elementDescription,
            maxResults: maxResults
        )
        let windows = targetWindows(for: appElement, searchAllWindows: searchAllWindows)

        var state = SearchState()
        for window in windows {
            search(
                element: window.element,
                pid: pid,
                appName: app.localizedName,
                windowIndex: window.index,
                windowTitle: stringAttribute(kAXTitleAttribute as CFString, of: window.element),
                path: [],
                depth: 0,
                query: query,
                state: &state
            )

            if state.matches.count >= query.maxResults || state.scannedElementCount >= query.maxNodes {
                break
            }
        }

        return UIElementQueryResult(
            pid: pid,
            appName: app.localizedName,
            searchedWindowCount: windows.count,
            scannedElementCount: state.scannedElementCount,
            matches: state.matches
        )
    }

    public static func pressElement(
        pid: pid_t,
        windowIndex: Int,
        path: [Int],
        action: String? = nil
    ) throws -> UIElementPressResult {
        try Allowlist.require(pid: pid)
        let app = try requireRunningApp(pid: pid)
        let appElement = try requireApplicationElement(pid: pid)
        let targetElement = try resolveElement(
            appElement: appElement,
            pid: pid,
            windowIndex: windowIndex,
            path: path
        )
        let actions = actionNames(of: targetElement)
        let chosenAction = try resolveActionName(preferredAction: action, availableActions: actions)

        let error = AXUIElementPerformAction(targetElement, chosenAction as CFString)
        guard error == .success else {
            throw ClaudexComputerUseCoreError.accessibilityOperationFailed(
                "AX action '\(chosenAction)' failed for PID=\(pid) with error \(error.rawValue)."
            )
        }

        return UIElementPressResult(
            pid: pid,
            appName: app.localizedName,
            windowIndex: windowIndex,
            path: path,
            role: stringAttribute(kAXRoleAttribute as CFString, of: targetElement),
            title: stringAttribute(kAXTitleAttribute as CFString, of: targetElement),
            action: chosenAction
        )
    }

    public static func setValue(
        pid: pid_t,
        windowIndex: Int,
        path: [Int],
        value: UIElementValueInput
    ) throws -> UIElementSetValueResult {
        try Allowlist.require(pid: pid)
        let app = try requireRunningApp(pid: pid)
        let appElement = try requireApplicationElement(pid: pid)
        let targetElement = try resolveElement(
            appElement: appElement,
            pid: pid,
            windowIndex: windowIndex,
            path: path
        )

        return try setValue(
            pid: pid,
            appName: app.localizedName,
            targetElement: targetElement,
            windowIndex: windowIndex,
            path: path,
            value: value
        )
    }

    public static func setValue(
        pid: pid_t,
        element: AXUIElement,
        windowIndex: Int,
        path: [Int],
        value: UIElementValueInput
    ) throws -> UIElementSetValueResult {
        try Allowlist.require(pid: pid)
        let app = try requireRunningApp(pid: pid)

        return try setValue(
            pid: pid,
            appName: app.localizedName,
            targetElement: element,
            windowIndex: windowIndex,
            path: path,
            value: value
        )
    }

    private static func setValue(
        pid: pid_t,
        appName: String?,
        targetElement: AXUIElement,
        windowIndex: Int,
        path: [Int],
        value: UIElementValueInput
    ) throws -> UIElementSetValueResult {

        guard isAttributeSettable(kAXValueAttribute as CFString, of: targetElement) else {
            throw ClaudexComputerUseCoreError.accessibilityOperationFailed(
                "AXValue is not settable for this UI element."
            )
        }

        let previousValue = valueString(of: targetElement)
        let error = AXUIElementSetAttributeValue(
            targetElement,
            kAXValueAttribute as CFString,
            value.axValue
        )
        guard error == .success else {
            throw ClaudexComputerUseCoreError.accessibilityOperationFailed(
                "Failed to set AXValue for PID=\(pid) with error \(error.rawValue)."
            )
        }

        return UIElementSetValueResult(
            pid: pid,
            appName: appName,
            windowIndex: windowIndex,
            path: path,
            role: stringAttribute(kAXRoleAttribute as CFString, of: targetElement),
            title: stringAttribute(kAXTitleAttribute as CFString, of: targetElement),
            valueType: value.valueType,
            requestedValue: value.displayValue,
            previousValue: previousValue,
            resultingValue: valueString(of: targetElement)
        )
    }

    private static func makeQuery(
        role: String?,
        text: String?,
        title: String?,
        value: String?,
        elementDescription: String?,
        maxResults: Int
    ) throws -> Query {
        let query = Query(
            role: normalizeAXName(trimmed(role)),
            text: trimmed(text),
            title: trimmed(title),
            value: trimmed(value),
            elementDescription: trimmed(elementDescription),
            maxResults: min(max(maxResults, 1), 25),
            maxDepth: 10,
            maxNodes: 2_000
        )

        guard query.hasAnyFilter else {
            throw ClaudexComputerUseCoreError.invalidArgument(
                "find_ui_element requires at least one of role, text, title, value, or description."
            )
        }

        return query
    }

    private static func search(
        element: AXUIElement,
        pid: pid_t,
        appName: String?,
        windowIndex: Int,
        windowTitle: String?,
        path: [Int],
        depth: Int,
        query: Query,
        state: inout SearchState
    ) {
        guard state.matches.count < query.maxResults else {
            return
        }
        guard state.scannedElementCount < query.maxNodes else {
            return
        }

        state.scannedElementCount += 1
        let snapshot = snapshot(
            of: element,
            pid: pid,
            appName: appName,
            windowIndex: windowIndex,
            windowTitle: windowTitle,
            path: path
        )
        if query.matches(snapshot) {
            state.matches.append(snapshot)
            guard state.matches.count < query.maxResults else {
                return
            }
        }

        guard depth < query.maxDepth else {
            return
        }

        let children = childElements(of: element)
        for (index, child) in children.enumerated() {
            var childPath = path
            childPath.append(index)
            search(
                element: child,
                pid: pid,
                appName: appName,
                windowIndex: windowIndex,
                windowTitle: windowTitle,
                path: childPath,
                depth: depth + 1,
                query: query,
                state: &state
            )

            if state.matches.count >= query.maxResults || state.scannedElementCount >= query.maxNodes {
                return
            }
        }
    }

    private static func snapshot(
        of element: AXUIElement,
        pid: pid_t,
        appName: String?,
        windowIndex: Int,
        windowTitle: String?,
        path: [Int]
    ) -> UIElementInfo {
        UIElementInfo(
            pid: pid,
            appName: appName,
            windowIndex: windowIndex,
            windowTitle: windowTitle,
            path: path,
            role: stringAttribute(kAXRoleAttribute as CFString, of: element),
            subrole: stringAttribute(kAXSubroleAttribute as CFString, of: element),
            title: stringAttribute(kAXTitleAttribute as CFString, of: element),
            value: valueString(of: element),
            elementDescription: stringAttribute(kAXDescriptionAttribute as CFString, of: element),
            identifier: stringAttribute(kAXIdentifierAttribute as CFString, of: element),
            frame: frame(of: element),
            enabled: boolAttribute(kAXEnabledAttribute as CFString, of: element),
            actions: actionNames(of: element)
        )
    }

    private static func resolveElement(
        appElement: AXUIElement,
        pid: pid_t,
        windowIndex: Int,
        path: [Int]
    ) throws -> AXUIElement {
        let root = try resolveWindowRoot(appElement: appElement, pid: pid, windowIndex: windowIndex)
        var current = root

        for childIndex in path {
            let children = childElements(of: current)
            guard children.indices.contains(childIndex) else {
                throw ClaudexComputerUseCoreError.uiElementNotFound(
                    pid: pid,
                    windowIndex: windowIndex,
                    path: path
                )
            }
            current = children[childIndex]
        }

        return current
    }

    private static func resolveWindowRoot(
        appElement: AXUIElement,
        pid: pid_t,
        windowIndex: Int
    ) throws -> AXUIElement {
        let windows = windowElements(of: appElement)
        if windows.indices.contains(windowIndex) {
            return windows[windowIndex]
        }

        if windowIndex == 0, let focusedWindow = elementAttribute(kAXFocusedWindowAttribute as CFString, of: appElement) {
            return focusedWindow
        }

        throw ClaudexComputerUseCoreError.uiElementNotFound(pid: pid, windowIndex: windowIndex, path: [])
    }

    private static func resolveActionName(
        preferredAction: String?,
        availableActions: [String]
    ) throws -> String {
        if let preferredAction = trimmed(preferredAction) {
            let normalized = normalizeAXName(preferredAction)
            if let match = availableActions.first(where: { normalizeAXName($0) == normalized }) {
                return match
            }

            throw ClaudexComputerUseCoreError.uiActionUnsupported(
                "UI element does not support action '\(preferredAction)'. Available actions: \(availableActions.joined(separator: ", "))."
            )
        }

        if let press = availableActions.first(where: { normalizeAXName($0) == normalizeAXName(kAXPressAction as String) }) {
            return press
        }

        throw ClaudexComputerUseCoreError.uiActionUnsupported(
            "UI element does not support AXPress. Available actions: \(availableActions.joined(separator: ", "))."
        )
    }

    private static func targetWindows(
        for appElement: AXUIElement,
        searchAllWindows: Bool
    ) -> [(index: Int, element: AXUIElement)] {
        let windows = windowElements(of: appElement)

        if searchAllWindows {
            if windows.isEmpty, let focusedWindow = elementAttribute(kAXFocusedWindowAttribute as CFString, of: appElement) {
                return [(0, focusedWindow)]
            }

            return windows.enumerated().map { item in
                (index: item.offset, element: item.element)
            }
        }

        if let focusedWindow = elementAttribute(kAXFocusedWindowAttribute as CFString, of: appElement) {
            if let index = windows.firstIndex(where: { elementsEqual($0, focusedWindow) }) {
                return [(index, focusedWindow)]
            }

            return [(0, focusedWindow)]
        }

        if let firstWindow = windows.first {
            return [(0, firstWindow)]
        }

        return []
    }

    private static func windowElements(of appElement: AXUIElement) -> [AXUIElement] {
        arrayOfElementsAttribute(kAXWindowsAttribute as CFString, of: appElement)
    }

    private static func childElements(of element: AXUIElement) -> [AXUIElement] {
        arrayOfElementsAttribute(kAXChildrenAttribute as CFString, of: element)
    }

    private static func requireApplicationElement(pid: pid_t) throws -> AXUIElement {
        guard AXIsProcessTrusted() else {
            throw ClaudexComputerUseCoreError.missingAccessibilityPermission
        }

        return AXUIElementCreateApplication(pid)
    }

    private static func requireRunningApp(pid: pid_t) throws -> NSRunningApplication {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            throw ClaudexComputerUseCoreError.processNotFound(pid)
        }

        return app
    }

    private static func valueString(of element: AXUIElement) -> String? {
        guard let value = rawAttribute(kAXValueAttribute as CFString, of: element) else {
            return nil
        }

        return stringify(value)
    }

    private static func frame(of element: AXUIElement) -> ScreenRect? {
        guard
            let position = cgPointAttribute(kAXPositionAttribute as CFString, of: element),
            let size = cgSizeAttribute(kAXSizeAttribute as CFString, of: element)
        else {
            return nil
        }

        return ScreenRect(
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height
        )
    }

    private static func stringAttribute(_ attribute: CFString, of element: AXUIElement) -> String? {
        guard let value = rawAttribute(attribute, of: element) else {
            return nil
        }

        return stringify(value)
    }

    private static func boolAttribute(_ attribute: CFString, of element: AXUIElement) -> Bool? {
        guard let value = rawAttribute(attribute, of: element) else {
            return nil
        }

        switch value {
        case let bool as Bool:
            return bool
        case let number as NSNumber:
            return number.boolValue
        default:
            return nil
        }
    }

    private static func cgPointAttribute(_ attribute: CFString, of element: AXUIElement) -> CGPoint? {
        guard let value = rawAttribute(attribute, of: element) else {
            return nil
        }

        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cgPoint else {
            return nil
        }

        var point = CGPoint.zero
        guard AXValueGetValue(axValue, .cgPoint, &point) else {
            return nil
        }

        return point
    }

    private static func cgSizeAttribute(_ attribute: CFString, of element: AXUIElement) -> CGSize? {
        guard let value = rawAttribute(attribute, of: element) else {
            return nil
        }

        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cgSize else {
            return nil
        }

        var size = CGSize.zero
        guard AXValueGetValue(axValue, .cgSize, &size) else {
            return nil
        }

        return size
    }

    private static func actionNames(of element: AXUIElement) -> [String] {
        var value: CFArray?
        let error = AXUIElementCopyActionNames(element, &value)
        guard error == .success else {
            return []
        }

        return (value as? [String]) ?? []
    }

    private static func isAttributeSettable(_ attribute: CFString, of element: AXUIElement) -> Bool {
        var settable = DarwinBoolean(false)
        let error = AXUIElementIsAttributeSettable(element, attribute, &settable)
        return error == .success && settable.boolValue
    }

    private static func elementAttribute(_ attribute: CFString, of element: AXUIElement) -> AXUIElement? {
        guard let value = rawAttribute(attribute, of: element) else {
            return nil
        }

        let cfValue = value as CFTypeRef
        guard CFGetTypeID(cfValue) == AXUIElementGetTypeID() else {
            return nil
        }
        return (cfValue as! AXUIElement)
    }

    private static func arrayOfElementsAttribute(_ attribute: CFString, of element: AXUIElement) -> [AXUIElement] {
        guard let value = rawAttribute(attribute, of: element) else {
            return []
        }

        if let array = value as? [AXUIElement] {
            return array
        }
        return []
    }

    private static func rawAttribute(_ attribute: CFString, of element: AXUIElement) -> Any? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute, &value)

        switch error {
        case .success:
            return value
        case .attributeUnsupported, .noValue, .cannotComplete:
            return nil
        default:
            return nil
        }
    }

    private static func normalizeAXName(_ value: String?) -> String? {
        guard let value = trimmed(value), !value.isEmpty else {
            return nil
        }

        let lowered = value.lowercased()
        if lowered.hasPrefix("ax") {
            return lowered
        }

        return "ax\(lowered)"
    }

    private static func containsCaseInsensitive(haystack: String?, needle: String) -> Bool {
        guard let haystack = haystack else {
            return false
        }

        return haystack.localizedCaseInsensitiveContains(needle)
    }

    private static func matchesText(_ text: String, element: UIElementInfo) -> Bool {
        containsCaseInsensitive(haystack: element.title, needle: text)
            || containsCaseInsensitive(haystack: element.value, needle: text)
            || containsCaseInsensitive(haystack: element.elementDescription, needle: text)
            || containsCaseInsensitive(haystack: element.identifier, needle: text)
    }

    private static func stringify(_ value: Any) -> String? {
        switch value {
        case let string as String:
            return trimmed(string)
        case let attributedString as NSAttributedString:
            return trimmed(attributedString.string)
        case let number as NSNumber:
            return number.stringValue
        case let url as URL:
            return url.absoluteString
        default:
            let rendered = String(describing: value)
            return trimmed(rendered)
        }
    }

    private static func trimmed(_ value: String?) -> String? {
        guard let value else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func elementsEqual(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool {
        CFEqual(lhs, rhs)
    }
}

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

public struct ScreenPoint: Codable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public var cgPoint: CGPoint {
        CGPoint(x: x, y: y)
    }
}

public struct CursorPosition: Codable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public init(_ point: CGPoint) {
        self.init(x: point.x, y: point.y)
    }
}

public enum MouseButton: String, Codable {
    case left
    case right
    case middle

    fileprivate var cgButton: CGMouseButton {
        switch self {
        case .left:
            return .left
        case .right:
            return .right
        case .middle:
            return .center
        }
    }

    fileprivate var downEventType: CGEventType {
        switch self {
        case .left:
            return .leftMouseDown
        case .right:
            return .rightMouseDown
        case .middle:
            return .otherMouseDown
        }
    }

    fileprivate var upEventType: CGEventType {
        switch self {
        case .left:
            return .leftMouseUp
        case .right:
            return .rightMouseUp
        case .middle:
            return .otherMouseUp
        }
    }
}

public struct ClickResult: Codable {
    public let pid: Int32
    public let appName: String?
    public let point: ScreenPoint
    public let mouseButton: MouseButton
    public let clickCount: Int
    public let cursorBefore: CursorPosition
    public let cursorAfter: CursorPosition
    public let cursorMoved: Bool
    public let deliveryMethod: String

    public init(
        pid: Int32,
        appName: String?,
        point: ScreenPoint,
        mouseButton: MouseButton,
        clickCount: Int,
        cursorBefore: CursorPosition,
        cursorAfter: CursorPosition,
        cursorMoved: Bool,
        deliveryMethod: String = "background-event-unverified"
    ) {
        self.pid = pid
        self.appName = appName
        self.point = point
        self.mouseButton = mouseButton
        self.clickCount = clickCount
        self.cursorBefore = cursorBefore
        self.cursorAfter = cursorAfter
        self.cursorMoved = cursorMoved
        self.deliveryMethod = deliveryMethod
    }
}

public struct TextInjectionResult: Codable {
    public let pid: Int32
    public let appName: String?
    public let text: String
    public let charactersSent: Int
    public let strategy: TextInjectionStrategy
    public let deliveryMode: InteractionDeliveryMode
    public let clipboardRestored: Bool
    public let restoredFocus: Bool
    public let frontmostBefore: FrontmostAppState
    public let frontmostAfter: FrontmostAppState

    public init(
        pid: Int32,
        appName: String?,
        text: String,
        charactersSent: Int,
        strategy: TextInjectionStrategy,
        deliveryMode: InteractionDeliveryMode,
        clipboardRestored: Bool,
        restoredFocus: Bool,
        frontmostBefore: FrontmostAppState,
        frontmostAfter: FrontmostAppState
    ) {
        self.pid = pid
        self.appName = appName
        self.text = text
        self.charactersSent = charactersSent
        self.strategy = strategy
        self.deliveryMode = deliveryMode
        self.clipboardRestored = clipboardRestored
        self.restoredFocus = restoredFocus
        self.frontmostBefore = frontmostBefore
        self.frontmostAfter = frontmostAfter
    }
}

public enum TextInjectionStrategy: String, Codable {
    case auto
    case unicodeEvent
    case pasteboard
}

public enum ScrollDirection: String, Codable {
    case up
    case down
    case left
    case right
}

public enum ScrollStrategy: String, Codable {
    case accessibilityAction
    case eventInjection
}

public struct DragResult: Codable {
    public let pid: Int32
    public let appName: String?
    public let from: ScreenPoint
    public let to: ScreenPoint

    public init(pid: Int32, appName: String?, from: ScreenPoint, to: ScreenPoint) {
        self.pid = pid
        self.appName = appName
        self.from = from
        self.to = to
    }
}

public struct ScrollResult: Codable {
    public let pid: Int32
    public let appName: String?
    public let direction: ScrollDirection
    public let amount: Int
    public let deltaX: Int32
    public let deltaY: Int32
    public let strategy: ScrollStrategy
    public let targetPoint: ScreenPoint?

    public init(
        pid: Int32,
        appName: String?,
        direction: ScrollDirection,
        amount: Int,
        deltaX: Int32,
        deltaY: Int32,
        strategy: ScrollStrategy,
        targetPoint: ScreenPoint?
    ) {
        self.pid = pid
        self.appName = appName
        self.direction = direction
        self.amount = amount
        self.deltaX = deltaX
        self.deltaY = deltaY
        self.strategy = strategy
        self.targetPoint = targetPoint
    }
}

public enum ClaudexComputerUseCoreError: LocalizedError {
    case missingAccessibilityPermission
    case missingScreenRecordingPermission
    case processNotFound(pid_t)
    case windowNotFound(pid: pid_t, windowID: UInt32?)
    case uiElementNotFound(pid: pid_t, windowIndex: Int, path: [Int])
    case eventSourceUnavailable
    case eventCreationFailed(String)
    case pngEncodingFailed
    case fileWriteFailed(String)
    case unsupportedFeature(String)
    case invalidArgument(String)
    case captureFailed(String)
    case uiActionUnsupported(String)
    case accessibilityOperationFailed(String)
    case appNotAllowed(String)
    case desktopSessionConflict(String)
    case staleSnapshot(appName: String)

    public var errorDescription: String? {
        switch self {
        case .missingAccessibilityPermission:
            return "Accessibility permission is required before Claudex Computer Use can inject input."
        case .missingScreenRecordingPermission:
            return "Screen Recording permission is required before Claudex Computer Use can capture window images."
        case .processNotFound(let pid):
            return "Could not find a running app for PID=\(pid)."
        case .windowNotFound(let pid, let windowID):
            if let windowID {
                return "Could not find windowID=\(windowID) for PID=\(pid)."
            }

            return "Could not find a captureable window for PID=\(pid)."
        case .uiElementNotFound(let pid, let windowIndex, let path):
            let renderedPath = path.isEmpty ? "(root)" : path.map(String.init).joined(separator: ",")
            return "Could not resolve a UI element for PID=\(pid) at windowIndex=\(windowIndex), path=\(renderedPath)."
        case .eventSourceUnavailable:
            return "Failed to create a private CGEventSource."
        case .eventCreationFailed(let kind):
            return "Failed to create \(kind) CGEvent."
        case .pngEncodingFailed:
            return "Failed to encode the captured image as PNG."
        case .fileWriteFailed(let path):
            return "Failed to write the captured image to \(path)."
        case .unsupportedFeature(let feature):
            return "\(feature) is not available on this macOS version."
        case .invalidArgument(let message):
            return message
        case .captureFailed(let message):
            return message
        case .uiActionUnsupported(let message):
            return message
        case .accessibilityOperationFailed(let message):
            return message
        case .appNotAllowed(let message):
            return message
        case .desktopSessionConflict(let message):
            return message
        case .staleSnapshot(let appName):
            return "The user changed '\(appName)'. Re-query the latest state with `get_app_state` before sending more actions."
        }
    }
}

public enum InputInjector {
    public static func click(
        pid: pid_t,
        at point: ScreenPoint,
        button: MouseButton = .left,
        clickCount: Int = 1,
        deliveryMode: InteractionDeliveryMode = .background,
        restoreFocus: Bool = true,
        downUpDelay: TimeInterval = 0.05,
        settleDelay: TimeInterval = 0.2
    ) throws -> ClickResult {
        guard AXIsProcessTrusted() else {
            throw ClaudexComputerUseCoreError.missingAccessibilityPermission
        }
        try Allowlist.require(pid: pid)
        guard clickCount > 0 else {
            throw ClaudexComputerUseCoreError.invalidArgument("click_count must be greater than 0.")
        }

        let app = try requireRunningApp(pid: pid)
        let cursorBefore = CursorPosition(NSEvent.mouseLocation)
        let source = try makeEventSource()

        // App-scoped AX hit testing gives coordinate clicks a reliable background
        // path for native controls, without touching the physical cursor/focus.
        if deliveryMode == .background && button == .left && clickCount == 1 {
            var hit: AXUIElement?
            let root = AXUIElementCreateApplication(pid)
            if AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &hit) == .success,
               let hit {
                var hitPID: pid_t = 0
                var actions: CFArray?
                if AXUIElementGetPid(hit, &hitPID) == .success, hitPID == pid,
                   AXUIElementCopyActionNames(hit, &actions) == .success,
                   (actions as? [String])?.contains(kAXPressAction as String) == true,
                   AXUIElementPerformAction(hit, kAXPressAction as CFString) == .success {
                    Thread.sleep(forTimeInterval: settleDelay)
                    return ClickResult(pid: pid, appName: app.localizedName, point: point,
                                       mouseButton: button, clickCount: clickCount,
                                       cursorBefore: cursorBefore, cursorAfter: CursorPosition(NSEvent.mouseLocation),
                                       cursorMoved: false, deliveryMethod: "accessibility-press")
                }
            }
        }

        let previousApp = NSWorkspace.shared.frontmostApplication
        let previousCursor = CGEvent(source: nil)?.location
        if deliveryMode == .direct {
            guard app.activate(options: [.activateIgnoringOtherApps]) else {
                throw ClaudexComputerUseCoreError.eventCreationFailed("Could not focus target app for explicit direct click")
            }
            Thread.sleep(forTimeInterval: 0.15)
        }
        defer {
            if deliveryMode == .direct {
                // Do not overwrite a new user cursor/focus change during delivery.
                if let previousCursor, let current = CGEvent(source: nil)?.location,
                   abs(current.x - point.x) < 2, abs(current.y - point.y) < 2 {
                    CGWarpMouseCursorPosition(previousCursor)
                }
                if restoreFocus, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                   let previousApp, previousApp.processIdentifier != pid {
                    previousApp.activate(options: [.activateIgnoringOtherApps])
                }
            }
        }
        if deliveryMode == .direct {
            var hit: AXUIElement?; var hitPID: pid_t = 0
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                  AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
                  let hit, AXUIElementGetPid(hit, &hitPID) == .success, hitPID == pid else {
                throw ClaudexComputerUseCoreError.eventCreationFailed("Direct click point is not owned by the target app")
            }
        }

        for index in 0..<clickCount {
            guard
                let mouseDown = CGEvent(
                    mouseEventSource: source,
                    mouseType: button.downEventType,
                    mouseCursorPosition: point.cgPoint,
                    mouseButton: button.cgButton
                ),
                let mouseUp = CGEvent(
                    mouseEventSource: source,
                    mouseType: button.upEventType,
                    mouseCursorPosition: point.cgPoint,
                    mouseButton: button.cgButton
                )
            else {
                throw ClaudexComputerUseCoreError.eventCreationFailed("mouse click")
            }

            let clickState = Int64(index + 1)
            mouseDown.setIntegerValueField(.mouseEventClickState, value: clickState)
            mouseUp.setIntegerValueField(.mouseEventClickState, value: clickState)

            if deliveryMode == .direct { mouseDown.post(tap: .cghidEventTap) } else { mouseDown.postToPid(pid) }
            Thread.sleep(forTimeInterval: downUpDelay)
            if deliveryMode == .direct { mouseUp.post(tap: .cghidEventTap) } else { mouseUp.postToPid(pid) }

            if index + 1 < clickCount {
                Thread.sleep(forTimeInterval: downUpDelay)
            }
        }
        Thread.sleep(forTimeInterval: settleDelay)

        let cursorAfter = CursorPosition(NSEvent.mouseLocation)
        let cursorMoved = abs(cursorAfter.x - cursorBefore.x) > 1 || abs(cursorAfter.y - cursorBefore.y) > 1

        return ClickResult(
            pid: pid,
            appName: app.localizedName,
            point: point,
            mouseButton: button,
            clickCount: clickCount,
            cursorBefore: cursorBefore,
            cursorAfter: cursorAfter,
            cursorMoved: cursorMoved,
            deliveryMethod: deliveryMode == .direct ? "foreground-event" : "background-event-unverified"
        )
    }

    public static func typeText(
        pid: pid_t,
        text: String,
        strategy: TextInjectionStrategy = .auto,
        deliveryMode: InteractionDeliveryMode = .background,
        restoreFocus: Bool = false,
        keystrokeDelay: TimeInterval = 0.01
    ) throws -> TextInjectionResult {
        guard AXIsProcessTrusted() else {
            throw ClaudexComputerUseCoreError.missingAccessibilityPermission
        }
        try Allowlist.require(pid: pid)

        let app = try requireRunningApp(pid: pid)
        let resolvedStrategy = resolvedTextInjectionStrategy(
            requested: strategy,
            app: app,
            text: text
        )

        let outcome: (frontmostBefore: FrontmostAppState, frontmostAfter: FrontmostAppState, clipboardRestored: Bool)
        switch resolvedStrategy {
        case .pasteboard:
            let paste = try PasteboardInjector.pasteText(
                text,
                into: pid,
                mode: deliveryMode,
                restoreFocus: restoreFocus
            )
            outcome = (
                frontmostBefore: paste.frontmostBefore,
                frontmostAfter: paste.frontmostAfter,
                clipboardRestored: paste.clipboardRestored
            )
        case .unicodeEvent:
            let source = try makeEventSource()
            let delivery = try InteractionDelivery.perform(
                targetPID: pid,
                mode: deliveryMode,
                restoreFocus: restoreFocus
            ) {
                for scalar in text.unicodeScalars {
                    let fragment = String(scalar)
                    let utf16 = Array(fragment.utf16)

                    guard
                        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
                    else {
                        throw ClaudexComputerUseCoreError.eventCreationFailed("keyboard event")
                    }

                    keyDown.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                    keyUp.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                    keyDown.postToPid(pid)
                    keyUp.postToPid(pid)
                    Thread.sleep(forTimeInterval: keystrokeDelay)
                }
            }
            outcome = (
                frontmostBefore: delivery.frontmostBefore,
                frontmostAfter: delivery.frontmostAfter,
                clipboardRestored: false
            )
        case .auto:
            fatalError("auto strategy must be resolved before dispatch")
        }

        return TextInjectionResult(
            pid: pid,
            appName: app.localizedName,
            text: text,
            charactersSent: text.count,
            strategy: resolvedStrategy,
            deliveryMode: deliveryMode,
            clipboardRestored: outcome.clipboardRestored,
            restoredFocus: restoreFocus,
            frontmostBefore: outcome.frontmostBefore,
            frontmostAfter: outcome.frontmostAfter
        )
    }

    public static func drag(
        pid: pid_t,
        from: ScreenPoint,
        to: ScreenPoint,
        steps: Int = 10,
        stepDelay: TimeInterval = 0.01,
        settleDelay: TimeInterval = 0.3
    ) throws -> DragResult {
        guard AXIsProcessTrusted() else {
            throw ClaudexComputerUseCoreError.missingAccessibilityPermission
        }
        try Allowlist.require(pid: pid)

        let app = try requireRunningApp(pid: pid)
        let source = try makeEventSource()

        // Mouse down at start
        guard let mouseDown = CGEvent(
            mouseEventSource: source,
            mouseType: .leftMouseDown,
            mouseCursorPosition: from.cgPoint,
            mouseButton: .left
        ) else {
            throw ClaudexComputerUseCoreError.eventCreationFailed("drag mouse down")
        }
        mouseDown.postToPid(pid)
        Thread.sleep(forTimeInterval: stepDelay)

        // Move in steps
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let x = from.x + (to.x - from.x) * t
            let y = from.y + (to.y - from.y) * t
            guard let mouseDrag = CGEvent(
                mouseEventSource: source,
                mouseType: .leftMouseDragged,
                mouseCursorPosition: CGPoint(x: x, y: y),
                mouseButton: .left
            ) else {
                throw ClaudexComputerUseCoreError.eventCreationFailed("drag mouse move")
            }
            mouseDrag.postToPid(pid)
            Thread.sleep(forTimeInterval: stepDelay)
        }

        // Mouse up at end
        guard let mouseUp = CGEvent(
            mouseEventSource: source,
            mouseType: .leftMouseUp,
            mouseCursorPosition: to.cgPoint,
            mouseButton: .left
        ) else {
            throw ClaudexComputerUseCoreError.eventCreationFailed("drag mouse up")
        }
        mouseUp.postToPid(pid)
        Thread.sleep(forTimeInterval: settleDelay)

        return DragResult(pid: pid, appName: app.localizedName, from: from, to: to)
    }

    public static func scroll(
        pid: pid_t,
        direction: ScrollDirection,
        amount: Int = 3,
        at point: ScreenPoint? = nil,
        stepDelay: TimeInterval = 0.005,
        settleDelay: TimeInterval = 0.3
    ) throws -> ScrollResult {
        guard AXIsProcessTrusted() else {
            throw ClaudexComputerUseCoreError.missingAccessibilityPermission
        }
        try Allowlist.require(pid: pid)

        guard amount > 0 else {
            throw ClaudexComputerUseCoreError.invalidArgument("scroll amount must be greater than 0.")
        }

        let app = try requireRunningApp(pid: pid)
        let source = try makeEventSource()
        let unitDelta = scrollDelta(for: direction)
        let targetPoint = point?.cgPoint ?? preferredScrollLocation(pid: pid)
        let renderedTargetPoint = targetPoint.map(CursorPosition.init).map { ScreenPoint(x: $0.x, y: $0.y) }
        let actionCount = max(1, Int(ceil(Double(amount) / 12.0)))

        if point == nil, performAXScrollIfPossible(pid: pid, direction: direction, count: actionCount) {
            return ScrollResult(
                pid: pid,
                appName: app.localizedName,
                direction: direction,
                amount: amount,
                deltaX: Int32(amount) * unitDelta.deltaX,
                deltaY: Int32(amount) * unitDelta.deltaY,
                strategy: .accessibilityAction,
                targetPoint: renderedTargetPoint
            )
        }

        for _ in 0..<amount {
            guard let scrollEvent = CGEvent(
                scrollWheelEvent2Source: source,
                units: .line,
                wheelCount: 2,
                wheel1: unitDelta.deltaY,
                wheel2: unitDelta.deltaX,
                wheel3: 0
            ) else {
                throw ClaudexComputerUseCoreError.eventCreationFailed("scroll event")
            }

            if let targetPoint {
                scrollEvent.location = targetPoint
            }
            scrollEvent.postToPid(pid)
            Thread.sleep(forTimeInterval: stepDelay)
        }

        Thread.sleep(forTimeInterval: settleDelay)

        return ScrollResult(
            pid: pid,
            appName: app.localizedName,
            direction: direction,
            amount: amount,
            deltaX: Int32(amount) * unitDelta.deltaX,
            deltaY: Int32(amount) * unitDelta.deltaY,
            strategy: .eventInjection,
            targetPoint: renderedTargetPoint
        )
    }

    private static func makeEventSource() throws -> CGEventSource {
        guard let source = CGEventSource(stateID: .privateState) else {
            throw ClaudexComputerUseCoreError.eventSourceUnavailable
        }
        return source
    }

    private static func scrollDelta(for direction: ScrollDirection) -> (deltaX: Int32, deltaY: Int32) {
        switch direction {
        case .up:
            return (deltaX: 0, deltaY: 1)
        case .down:
            return (deltaX: 0, deltaY: -1)
        case .left:
            return (deltaX: -1, deltaY: 0)
        case .right:
            return (deltaX: 1, deltaY: 0)
        }
    }

    private static func resolvedTextInjectionStrategy(
        requested: TextInjectionStrategy,
        app: NSRunningApplication,
        text: String
    ) -> TextInjectionStrategy {
        guard requested == .auto else {
            return requested
        }

        let markers = [
            app.localizedName ?? "",
            app.bundleIdentifier ?? ""
        ]
        .joined(separator: " ")
        .lowercased()

        let likelyCustomRendered = [
            "slack",
            "discord",
            "notion",
            "wechat",
            "wework",
            "feishu",
            "lark",
            "codebuddy",
            "electron"
        ]
        .contains { markers.contains($0) }

        let hasNonASCII = text.unicodeScalars.contains { !$0.isASCII }
        if likelyCustomRendered || hasNonASCII {
            return .pasteboard
        }

        return .unicodeEvent
    }

    private static func preferredScrollLocation(pid: pid_t) -> CGPoint? {
        let appElement = AXUIElementCreateApplication(pid)
        let window = axElementAttribute(kAXFocusedWindowAttribute as CFString, of: appElement)
            ?? axArrayAttribute(kAXWindowsAttribute as CFString, of: appElement).first

        guard
            let window,
            let position = cgPointAttribute(kAXPositionAttribute as CFString, of: window),
            let size = cgSizeAttribute(kAXSizeAttribute as CFString, of: window)
        else {
            return nil
        }

        return CGPoint(
            x: position.x + size.width / 2,
            y: position.y + size.height / 2
        )
    }

    private static func performAXScrollIfPossible(
        pid: pid_t,
        direction: ScrollDirection,
        count: Int
    ) -> Bool {
        let appElement = AXUIElementCreateApplication(pid)
        let startElement = axElementAttribute(kAXFocusedUIElementAttribute as CFString, of: appElement)
            ?? axElementAttribute(kAXFocusedWindowAttribute as CFString, of: appElement)
            ?? axArrayAttribute(kAXWindowsAttribute as CFString, of: appElement).first
        var current = startElement

        while let element = current {
            let actions = axActionNames(of: element)
            if let action = scrollActionName(for: direction, availableActions: actions) {
                for _ in 0..<count {
                    let error = AXUIElementPerformAction(element, action as CFString)
                    guard error == .success else {
                        return false
                    }
                }
                return true
            }

            current = axElementAttribute(kAXParentAttribute as CFString, of: element)
        }

        if let startElement, let scrollable = findScrollableDescendant(from: startElement, direction: direction) {
            let actions = axActionNames(of: scrollable)
            guard let action = scrollActionName(for: direction, availableActions: actions) else {
                return false
            }

            for _ in 0..<count {
                let error = AXUIElementPerformAction(scrollable, action as CFString)
                guard error == .success else {
                    return false
                }
            }

            return true
        }

        return false
    }

    private static func scrollActionName(
        for direction: ScrollDirection,
        availableActions: [String]
    ) -> String? {
        let wantedAction: String
        switch direction {
        case .up:
            wantedAction = "AXScrollUpByPage"
        case .down:
            wantedAction = "AXScrollDownByPage"
        case .left:
            wantedAction = "AXScrollLeftByPage"
        case .right:
            wantedAction = "AXScrollRightByPage"
        }

        return availableActions.first(where: { $0 == wantedAction })
    }

    private static func axActionNames(of element: AXUIElement) -> [String] {
        var value: CFArray?
        let error = AXUIElementCopyActionNames(element, &value)
        guard error == .success else {
            return []
        }

        return (value as? [String]) ?? []
    }

    private static func findScrollableDescendant(
        from root: AXUIElement,
        direction: ScrollDirection
    ) -> AXUIElement? {
        var queue: [AXUIElement] = [root]
        var index = 0
        let maxNodes = 64

        while index < queue.count, index < maxNodes {
            let element = queue[index]
            index += 1

            let actions = axActionNames(of: element)
            if scrollActionName(for: direction, availableActions: actions) != nil {
                return element
            }

            queue.append(contentsOf: axArrayAttribute(kAXChildrenAttribute as CFString, of: element))
        }

        return nil
    }

    private static func axElementAttribute(_ attribute: CFString, of element: AXUIElement) -> AXUIElement? {
        guard let value = rawAXAttribute(attribute, of: element) else {
            return nil
        }

        let cfValue = value as CFTypeRef
        guard CFGetTypeID(cfValue) == AXUIElementGetTypeID() else {
            return nil
        }
        return (cfValue as! AXUIElement)
    }

    private static func axArrayAttribute(_ attribute: CFString, of element: AXUIElement) -> [AXUIElement] {
        guard let value = rawAXAttribute(attribute, of: element) else {
            return []
        }

        return (value as? [AXUIElement]) ?? []
    }

    private static func cgPointAttribute(_ attribute: CFString, of element: AXUIElement) -> CGPoint? {
        guard let value = rawAXAttribute(attribute, of: element) else {
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
        guard let value = rawAXAttribute(attribute, of: element) else {
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

    private static func rawAXAttribute(_ attribute: CFString, of element: AXUIElement) -> Any? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard error == .success else {
            return nil
        }

        return value
    }

    private static func requireRunningApp(pid: pid_t) throws -> NSRunningApplication {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            throw ClaudexComputerUseCoreError.processNotFound(pid)
        }
        return app
    }
}

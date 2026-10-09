import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

public struct KeyPressResult: Codable {
    public let pid: Int32
    public let appName: String?
    public let key: String
    public let modifiers: [String]
    public let deliveryMode: InteractionDeliveryMode
    public let restoredFocus: Bool
    public let frontmostBefore: FrontmostAppState
    public let frontmostAfter: FrontmostAppState

    public init(
        pid: Int32,
        appName: String?,
        key: String,
        modifiers: [String],
        deliveryMode: InteractionDeliveryMode,
        restoredFocus: Bool,
        frontmostBefore: FrontmostAppState,
        frontmostAfter: FrontmostAppState
    ) {
        self.pid = pid
        self.appName = appName
        self.key = key
        self.modifiers = modifiers
        self.deliveryMode = deliveryMode
        self.restoredFocus = restoredFocus
        self.frontmostBefore = frontmostBefore
        self.frontmostAfter = frontmostAfter
    }
}

public enum KeyInjector {
    /// Parse and inject a key combination like "super+f", "ctrl+shift+a", "Up", "Return", "Tab".
    /// Modifier names: super/cmd/command, ctrl/control, alt/option, shift.
    public static func pressKey(
        pid: pid_t,
        key keySpec: String,
        deliveryMode: InteractionDeliveryMode = .background,
        restoreFocus: Bool = false,
        settleDelay: TimeInterval = 0.05
    ) throws -> KeyPressResult {
        guard AXIsProcessTrusted() else {
            throw ClaudexComputerUseCoreError.missingAccessibilityPermission
        }
        try Allowlist.require(pid: pid)

        let app = try requireRunningApp(pid: pid)
        let parsed = try parseKeySpec(keySpec)
        let source = try makeEventSource()

        guard
            let keyDown = CGEvent(keyboardEventSource: source, virtualKey: parsed.keyCode, keyDown: true),
            let keyUp = CGEvent(keyboardEventSource: source, virtualKey: parsed.keyCode, keyDown: false)
        else {
            throw ClaudexComputerUseCoreError.eventCreationFailed("key press")
        }

        keyDown.flags = parsed.flags
        keyUp.flags = parsed.flags

        let delivery = try InteractionDelivery.perform(
            targetPID: pid,
            mode: deliveryMode,
            restoreFocus: restoreFocus
        ) {
            keyDown.postToPid(pid)
            keyUp.postToPid(pid)
            Thread.sleep(forTimeInterval: settleDelay)
        }

        return KeyPressResult(
            pid: pid,
            appName: app.localizedName,
            key: parsed.keyName,
            modifiers: parsed.modifierNames,
            deliveryMode: deliveryMode,
            restoredFocus: restoreFocus,
            frontmostBefore: delivery.frontmostBefore,
            frontmostAfter: delivery.frontmostAfter
        )
    }

    private struct ParsedKey {
        let keyCode: CGKeyCode
        let keyName: String
        let flags: CGEventFlags
        let modifierNames: [String]
    }

    private static func parseKeySpec(_ spec: String) throws -> ParsedKey {
        let parts = spec.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
        guard !parts.isEmpty else {
            throw ClaudexComputerUseCoreError.invalidArgument("Key spec must not be empty.")
        }

        var flags = CGEventFlags()
        var modifierNames: [String] = []
        let keyPart = parts.last!
        let modifierParts = parts.dropLast()

        for modifier in modifierParts {
            switch modifier.lowercased() {
            case "super", "cmd", "command":
                flags.insert(.maskCommand)
                modifierNames.append("command")
            case "ctrl", "control":
                flags.insert(.maskControl)
                modifierNames.append("control")
            case "alt", "option":
                flags.insert(.maskAlternate)
                modifierNames.append("option")
            case "shift":
                flags.insert(.maskShift)
                modifierNames.append("shift")
            default:
                throw ClaudexComputerUseCoreError.invalidArgument("Unknown modifier: '\(modifier)'. Use super/ctrl/alt/shift.")
            }
        }

        guard let keyCode = virtualKeyCode(for: keyPart) else {
            throw ClaudexComputerUseCoreError.invalidArgument("Unknown key: '\(keyPart)'. See docs for supported key names.")
        }

        return ParsedKey(keyCode: keyCode, keyName: keyPart, flags: flags, modifierNames: modifierNames)
    }

    private static func virtualKeyCode(for name: String) -> CGKeyCode? {
        // Check single character first
        if name.count == 1, let code = charToKeyCode[name.lowercased()] {
            return code
        }
        return namedKeyCode[name.lowercased()] ?? namedKeyCode[name]
    }

    private static let namedKeyCode: [String: CGKeyCode] = [
        // Navigation
        "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
        "Up": 0x7E, "Down": 0x7D, "Left": 0x7B, "Right": 0x7C,
        "page_up": 0x74, "page_down": 0x79,
        "Page_Up": 0x74, "Page_Down": 0x79,
        "pageup": 0x74, "pagedown": 0x79,
        "home": 0x73, "end": 0x77,
        "Home": 0x73, "End": 0x77,

        // Editing
        "return": 0x24, "enter": 0x24,
        "Return": 0x24, "Enter": 0x24,
        "tab": 0x30, "Tab": 0x30,
        "space": 0x31, "Space": 0x31,
        "backspace": 0x33, "BackSpace": 0x33, "delete": 0x33,
        "forwarddelete": 0x75, "Delete": 0x75,
        "escape": 0x35, "Escape": 0x35, "esc": 0x35,

        // Function keys
        "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
        "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
        "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    ]

    private static let charToKeyCode: [String: CGKeyCode] = [
        "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02,
        "e": 0x0E, "f": 0x03, "g": 0x05, "h": 0x04,
        "i": 0x22, "j": 0x26, "k": 0x28, "l": 0x25,
        "m": 0x2E, "n": 0x2D, "o": 0x1F, "p": 0x23,
        "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11,
        "u": 0x20, "v": 0x09, "w": 0x0D, "x": 0x07,
        "y": 0x10, "z": 0x06,
        "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14,
        "4": 0x15, "5": 0x17, "6": 0x16, "7": 0x1A,
        "8": 0x1C, "9": 0x19,
        "-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E,
        "\\": 0x2A, ";": 0x29, "'": 0x27, ",": 0x2B,
        ".": 0x2F, "/": 0x2C, "`": 0x32,
    ]

    private static func makeEventSource() throws -> CGEventSource {
        guard let source = CGEventSource(stateID: .privateState) else {
            throw ClaudexComputerUseCoreError.eventSourceUnavailable
        }
        return source
    }

    private static func requireRunningApp(pid: pid_t) throws -> NSRunningApplication {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            throw ClaudexComputerUseCoreError.processNotFound(pid)
        }
        return app
    }
}

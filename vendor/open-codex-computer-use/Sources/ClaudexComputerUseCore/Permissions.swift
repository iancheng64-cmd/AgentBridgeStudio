import ApplicationServices
import CoreGraphics
import Foundation

public struct PermissionStatus: Codable {
    public let accessibilityTrusted: Bool
    public let screenRecordingTrusted: Bool

    public init(accessibilityTrusted: Bool, screenRecordingTrusted: Bool) {
        self.accessibilityTrusted = accessibilityTrusted
        self.screenRecordingTrusted = screenRecordingTrusted
    }
}

public enum PermissionManager {
    public static func snapshot(
        promptForAccessibility: Bool = false,
        promptForScreenRecording: Bool = false
    ) -> PermissionStatus {
        return PermissionStatus(
            accessibilityTrusted: accessibilityTrusted(prompt: promptForAccessibility),
            screenRecordingTrusted: screenRecordingTrusted(prompt: promptForScreenRecording)
        )
    }

    public static func accessibilityTrusted(prompt: Bool = false) -> Bool {
        if prompt {
            return AXIsProcessTrustedWithOptions(
                [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
            )
        }

        return AXIsProcessTrusted()
    }

    public static func screenRecordingTrusted(prompt: Bool = false) -> Bool {
        if #available(macOS 10.15, *) {
            let trusted = CGPreflightScreenCaptureAccess()
            if !trusted && prompt {
                _ = CGRequestScreenCaptureAccess()
            }
            return CGPreflightScreenCaptureAccess()
        }

        return true
    }
}

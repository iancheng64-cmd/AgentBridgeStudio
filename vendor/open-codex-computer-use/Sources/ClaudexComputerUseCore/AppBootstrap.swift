import AppKit
import Foundation

public enum AppBootstrap {
    private static var didInitialize = false

    public static func ensureInitialized() {
        guard !didInitialize else {
            return
        }
        didInitialize = true

        // In headless/MCP mode, skip NSApplication setup to avoid hanging
        // when spawned by a parent process without a window server connection.
        if ProcessInfo.processInfo.environment["CLAUDEX_COMPUTER_USE_HEADLESS"] == "1" {
            return
        }

        // NSApplication.shared is needed for NSWorkspace and NSRunningApplication
        // but can block in some subprocess environments.
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
    }
}

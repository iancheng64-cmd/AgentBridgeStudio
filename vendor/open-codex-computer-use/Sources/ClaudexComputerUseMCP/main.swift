import AppKit
import ApplicationServices
import Foundation
import ClaudexComputerUseCore

enum ToolCallError: LocalizedError {
    case invalidArguments(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let message):
            return message
        }
    }
}

enum RPCError: LocalizedError {
    case invalidRequest(String)

    var errorDescription: String? {
        switch self {
        case .invalidRequest(let message):
            return message
        }
    }
}

private struct PerformedActionResult: Codable {
    let action: String
    let elementIndex: Int

    enum CodingKeys: String, CodingKey {
        case action
        case elementIndex = "element_index"
    }
}

private struct AppStateToolResult: Codable {
    let snapshot: AppStateSnapshot
    let guidance: AppGuidanceHint
    let screenshot: CapturedWindowMetadata?
    let desktopSession: DesktopSessionStatus
    let virtualCursor: VirtualCursorStatus
}

private enum HandshakeLog {
    static let enabled = ProcessInfo.processInfo.environment["CLAUDEX_COMPUTER_USE_MCP_DEBUG"] == "1"
    private static let path = "/tmp/claudex-computer-use-mcp-handshake.log"
    private static let lock = NSLock()

    static func log(_ message: String) {
        guard enabled else { return }
        let ts = ISO8601DateFormatter().string(from: Date())
        let line = "[\(ts)] [pid=\(ProcessInfo.processInfo.processIdentifier)] \(message)\n"
        lock.lock()
        defer { lock.unlock() }
        if let fh = FileHandle(forWritingAtPath: path) {
            fh.seekToEndOfFile()
            fh.write(line.data(using: .utf8)!)
            fh.closeFile()
        } else {
            FileManager.default.createFile(atPath: path, contents: line.data(using: .utf8))
        }
    }
}

@main
struct ClaudexComputerUseMCP {
    static func main() async {
        HandshakeLog.log("process started, args=\(CommandLine.arguments)")
        do {
            // Defer AppBootstrap to first tool call so MCP initialize handshake completes immediately.
            // NSApplication.shared can block when spawned by some parent processes.
            Allowlist.loadFromDefaultLocation()
            HandshakeLog.log("allowlist loaded, entering run loop")
            try await MCPServer().run()
            OverlayCursorController.shared.endDesktopSession()
            HandshakeLog.log("run loop exited normally (stdin closed)")
        } catch {
            OverlayCursorController.shared.endDesktopSession()
            HandshakeLog.log("run loop fatal: \(error)")
            fputs("claudex-computer-use mcp fatal error: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
}

private final class MCPServer {
    private let transport = StdioTransport()
    private var cancelledRequestIDs: Set<String> = []
    private let session = AppStateSession()

    private static let tools: [[String: Any]] = [
        [
            "name": "get_app_state",
            "description": "Get a full snapshot of an app's UI state: the complete Accessibility tree with numbered element indices, plus a screenshot and app guidance hints. This must be called before click, press_key, type_text, scroll, or set_value. The app parameter accepts a name (Safari), bundle ID (com.apple.Safari), or PID (1234).",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "app": [
                        "type": "string",
                        "description": "App name, bundle identifier, or PID."
                    ]
                ],
                "required": ["app"],
                "additionalProperties": false
            ]
        ],
        [
            "name": "acquire_desktop",
            "description": "Acquire a Claudex Computer Use desktop session. Shared mode is advisory; exclusive mode blocks if another Claudex Computer Use process already owns the desktop. Optionally focuses an app before capturing the session baseline.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "mode": [
                        "type": "string",
                        "description": "Desktop session mode: shared or exclusive. Defaults to shared."
                    ],
                    "action_budget": [
                        "type": "integer",
                        "description": "Optional max number of mutating actions before the session must be reacquired."
                    ],
                    "app": [
                        "type": "string",
                        "description": "Optional app name, bundle identifier, or PID to activate before acquiring the session."
                    ]
                ],
                "additionalProperties": false
            ]
        ],
        [
            "name": "desktop_status",
            "description": "Return the current Claudex Computer Use desktop session state, including interruption detection and cross-process lock status.",
            "inputSchema": [
                "type": "object",
                "properties": [:] as [String: Any],
                "additionalProperties": false
            ]
        ],
        [
            "name": "release_desktop",
            "description": "Release the active Claudex Computer Use desktop session and its cross-process desktop lock.",
            "inputSchema": [
                "type": "object",
                "properties": [:] as [String: Any],
                "additionalProperties": false
            ]
        ],
        [
            "name": "get_virtual_cursor",
            "description": "Return the virtual cursor configuration, buffered screenshot-overlay state, and live desktop overlay runtime status.",
            "inputSchema": [
                "type": "object",
                "properties": [:] as [String: Any],
                "additionalProperties": false
            ]
        ],
        [
            "name": "set_virtual_cursor",
            "description": "Configure the virtual cursor overlay mode. Presets can switch between a Codex-like demo cursor and a debug trail profile; explicit fields override the preset.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "preset": [
                        "type": "string",
                        "description": "Optional preset: codexDemo for the default live arrow experience, or debugTrace for a visible diagnostic trail."
                    ],
                    "mode": [
                        "type": "string",
                        "description": "Virtual cursor mode: off, screenshotOverlay, desktopOverlay, or hybrid."
                    ],
                    "style": [
                        "type": "string",
                        "description": "Virtual cursor style: ghostArrow (Codex-like default), secondCursor, or crosshair."
                    ],
                    "show_trail": [
                        "type": "boolean",
                        "description": "Whether to render historical trail marks on screenshot overlays. Desktop live overlay stays trail-free."
                    ],
                    "trail_limit": [
                        "type": "integer",
                        "description": "How many recent marks to keep in screenshot overlays."
                    ],
                    "max_age_seconds": [
                        "type": "number",
                        "description": "Maximum age of retained marks before they expire."
                    ],
                    "clear": [
                        "type": "boolean",
                        "description": "Clear the buffered interaction trail after applying config changes."
                    ]
                ],
                "additionalProperties": false
            ]
        ],
        [
            "name": "press_key",
            "description": "Send a keyboard shortcut or key press to a target app. Supports modifiers: super/cmd, ctrl, alt/option, shift. Examples: super+f, ctrl+shift+a, Up, Return, Tab, Page_Up, Escape. delivery=background posts directly to the target PID; delivery=direct temporarily activates the app first.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "app": [
                        "type": "string",
                        "description": "App name, bundle identifier, or PID."
                    ],
                    "key": [
                        "type": "string",
                        "description": "Key specification like super+f, Up, Return, Tab."
                    ],
                    "delivery": [
                        "type": "string",
                        "description": "Interaction delivery mode: background or direct. Defaults to background."
                    ],
                    "restore_focus": [
                        "type": "boolean",
                        "description": "When delivery=direct, restore the previously frontmost app after sending the key. Defaults to true for direct delivery."
                    ]
                ],
                "required": ["app", "key"],
                "additionalProperties": false
            ]
        ],
        [
            "name": "doctor",
            "description": "Report permission status and basic Claudex Computer Use environment details.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "prompt": [
                        "type": "boolean",
                        "description": "Prompt for missing Accessibility and Screen Recording permissions."
                    ]
                ],
                "additionalProperties": false
            ]
        ],
        [
            "name": "list_apps",
            "description": "List running macOS apps that Claudex Computer Use can potentially target.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "includeBackground": [
                        "type": "boolean",
                        "description": "Include background-only apps and agents."
                    ]
                ],
                "additionalProperties": false
            ]
        ],
        [
            "name": "click",
            "description": "Click on a UI element or global coordinate. Prefer element_index from get_app_state. Background coordinate clicks first use app-scoped AXPress; otherwise event delivery is best effort and the returned snapshot must be verified. Explicit delivery=direct activates the target app and uses a global mouse event only after verifying the point belongs to that app; it may temporarily move the physical cursor. Never silently escalate to direct mode.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "app": [
                        "type": "string",
                        "description": "App name, bundle identifier, or PID."
                    ],
                    "element_index": [
                        "type": "integer",
                        "description": "Element index from the most recent get_app_state snapshot."
                    ],
                    "x": [
                        "type": "number",
                        "description": "Global screen X coordinate (used when element_index is not provided)."
                    ],
                    "y": [
                        "type": "number",
                        "description": "Global screen Y coordinate (used when element_index is not provided)."
                    ],
                    "click_count": [
                        "type": "integer",
                        "description": "Number of clicks to perform; defaults to 1."
                    ],
                    "delivery": [
                        "type": "string",
                        "enum": ["background", "direct"],
                        "description": "Coordinate input delivery. Defaults to background. Direct explicitly allows temporary foreground focus and mouse movement."
                    ],
                    "restore_focus": [
                        "type": "boolean",
                        "description": "Restore prior focus after a direct coordinate click if the user has not changed focus. Defaults to true."
                    ],
                    "mouse_button": [
                        "type": "string",
                        "description": "Mouse button to use: left, right, or middle. Defaults to left."
                    ],
                    "pid": [
                        "type": "integer",
                        "description": "Legacy: process identifier. Prefer using app instead."
                    ]
                ],
                "additionalProperties": false
            ]
        ],
        [
            "name": "scroll",
            "description": "Scroll within a target app. Provide direction (up/down/left/right) and optionally amount or pages.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "app": [
                        "type": "string",
                        "description": "App name, bundle identifier, or PID."
                    ],
                    "direction": [
                        "type": "string",
                        "description": "Scroll direction: up, down, left, or right."
                    ],
                    "amount": [
                        "type": "integer",
                        "description": "Number of line-sized scroll steps; defaults to 3."
                    ],
                    "pages": [
                        "type": "integer",
                        "description": "Number of pages to scroll (overrides amount, 1 page = 12 lines)."
                    ],
                    "element_index": [
                        "type": "integer",
                        "description": "Element index to scroll within (uses element center as scroll target)."
                    ],
                    "x": [
                        "type": "number",
                        "description": "Optional global screen X coordinate for scroll target."
                    ],
                    "y": [
                        "type": "number",
                        "description": "Optional global screen Y coordinate for scroll target."
                    ],
                    "pid": [
                        "type": "integer",
                        "description": "Legacy: process identifier. Prefer using app instead."
                    ]
                ],
                "required": ["direction"],
                "additionalProperties": false
            ]
        ],
        [
            "name": "list_windows",
            "description": "List captureable windows discovered through macOS window APIs.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "pid": [
                        "type": "integer",
                        "description": "Optional process identifier to filter windows."
                    ],
                    "prompt": [
                        "type": "boolean",
                        "description": "Prompt for Screen Recording permission before listing windows."
                    ]
                ],
                "additionalProperties": false
            ]
        ],
        [
            "name": "capture_window",
            "description": "Capture a PNG image of a target window via the macOS window capture backend.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "pid": [
                        "type": "integer",
                        "description": "Target macOS process identifier."
                    ],
                    "windowId": [
                        "type": "integer",
                        "description": "Optional specific window identifier to capture."
                    ],
                    "scale": [
                        "type": "number",
                        "description": "Optional output scale multiplier; defaults to 1.0."
                    ],
                    "prompt": [
                        "type": "boolean",
                        "description": "Prompt for Screen Recording permission if needed."
                    ]
                ],
                "required": ["pid"],
                "additionalProperties": false
            ]
        ],
        [
            "name": "type_text",
            "description": "Inject text into a target app process. strategy=auto chooses between unicode key events and clipboard paste; delivery=direct temporarily activates the app first when focus is unreliable.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "app": [
                        "type": "string",
                        "description": "App name, bundle identifier, or PID."
                    ],
                    "pid": [
                        "type": "integer",
                        "description": "Legacy: target macOS process identifier."
                    ],
                    "text": [
                        "type": "string",
                        "description": "Text to inject into the target process."
                    ],
                    "strategy": [
                        "type": "string",
                        "description": "Text injection strategy: auto, unicodeEvent, or pasteboard."
                    ],
                    "delivery": [
                        "type": "string",
                        "description": "Interaction delivery mode: background or direct. Defaults to background."
                    ],
                    "restore_focus": [
                        "type": "boolean",
                        "description": "When delivery=direct, restore the previously frontmost app after typing. Defaults to true for direct delivery."
                    ]
                ],
                "required": ["text"],
                "additionalProperties": false
            ]
        ],
        [
            "name": "set_value",
            "description": "Set the AXValue of a UI element. Prefer app + element_index from get_app_state; legacy pid + windowIndex + path is also supported.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "app": [
                        "type": "string",
                        "description": "App name, bundle identifier, or PID."
                    ],
                    "element_index": [
                        "type": "integer",
                        "description": "Element index from the most recent get_app_state snapshot."
                    ],
                    "pid": [
                        "type": "integer",
                        "description": "Legacy: target macOS process identifier."
                    ],
                    "windowIndex": [
                        "type": "integer",
                        "description": "Legacy: window index returned by find_ui_element."
                    ],
                    "path": [
                        "type": "array",
                        "items": [
                            "type": "integer"
                        ],
                        "description": "Legacy: child-index path returned by find_ui_element. Use [] or omit to target the window root."
                    ],
                    "value": [
                        "type": ["string", "number", "boolean"],
                        "description": "New AXValue for the target element."
                    ]
                ],
                "required": ["value"],
                "additionalProperties": false
            ]
        ],
        [
            "name": "find_ui_element",
            "description": "Search an app's Accessibility tree and return matching UI elements with a reusable windowIndex/path locator.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "pid": [
                        "type": "integer",
                        "description": "Target macOS process identifier."
                    ],
                    "role": [
                        "type": "string",
                        "description": "Optional AX role filter such as button or AXTextField."
                    ],
                    "text": [
                        "type": "string",
                        "description": "Optional case-insensitive substring filter across AXTitle, AXValue, AXDescription, and AXIdentifier."
                    ],
                    "title": [
                        "type": "string",
                        "description": "Optional case-insensitive substring filter against AXTitle."
                    ],
                    "value": [
                        "type": "string",
                        "description": "Optional case-insensitive substring filter against AXValue."
                    ],
                    "description": [
                        "type": "string",
                        "description": "Optional case-insensitive substring filter against AXDescription."
                    ],
                    "maxResults": [
                        "type": "integer",
                        "description": "Maximum number of matches to return; defaults to 10."
                    ],
                    "allWindows": [
                        "type": "boolean",
                        "description": "Search every AX window instead of only the focused window."
                    ]
                ],
                "required": ["pid"],
                "additionalProperties": false
            ]
        ],
        [
            "name": "stop",
            "description": "Signal Claudex Computer Use to stop any pending work. Current alpha implementation acknowledges the signal; future versions will interrupt long-running action sequences.",
            "inputSchema": [
                "type": "object",
                "properties": [:] as [String: Any],
                "additionalProperties": false
            ]
        ],
        [
            "name": "get_allowlist",
            "description": "Return the current app allowlist configuration.",
            "inputSchema": [
                "type": "object",
                "properties": [:] as [String: Any],
                "additionalProperties": false
            ]
        ],
        [
            "name": "set_allowlist",
            "description": "Update the app allowlist. In allowlistOnly mode, only apps whose bundle ID is in allowedBundleIDs can be targeted. In allowAll mode (the default), all apps are allowed unless explicitly denied.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "mode": [
                        "type": "string",
                        "description": "Allowlist mode: allowAll or allowlistOnly."
                    ],
                    "allowedBundleIDs": [
                        "type": "array",
                        "items": ["type": "string"],
                        "description": "Bundle IDs that are explicitly allowed (used in allowlistOnly mode)."
                    ],
                    "deniedBundleIDs": [
                        "type": "array",
                        "items": ["type": "string"],
                        "description": "Bundle IDs that are explicitly denied (checked in both modes)."
                    ],
                    "persist": [
                        "type": "boolean",
                        "description": "Write the config to disk so it persists across restarts. Defaults to false."
                    ]
                ],
                "additionalProperties": false
            ]
        ],
        [
            "name": "perform_action",
            "description": "Perform a specific AX action (from the Secondary Actions list) on an element by index from the latest get_app_state snapshot.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "app": [
                        "type": "string",
                        "description": "App name, bundle identifier, or PID."
                    ],
                    "element_index": [
                        "type": "integer",
                        "description": "Element index from the most recent get_app_state snapshot."
                    ],
                    "action": [
                        "type": "string",
                        "description": "AX action name, e.g. AXShowMenu, AXScrollToVisible, AXRaise, AXCancel, AXPick, AXIncrement, AXDecrement."
                    ]
                ],
                "required": ["app", "element_index", "action"],
                "additionalProperties": false
            ]
        ],
        [
            "name": "perform_secondary_action",
            "description": "Invoke a secondary accessibility action exposed by an element from the latest get_app_state snapshot.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "app": [
                        "type": "string",
                        "description": "App name, bundle identifier, or PID."
                    ],
                    "element_index": [
                        "type": "integer",
                        "description": "Element index from the most recent get_app_state snapshot."
                    ],
                    "action": [
                        "type": "string",
                        "description": "AX action name, e.g. AXShowMenu, AXScrollToVisible, AXRaise, AXCancel, AXPick, AXIncrement, AXDecrement."
                    ]
                ],
                "required": ["app", "element_index", "action"],
                "additionalProperties": false
            ]
        ],
        [
            "name": "drag",
            "description": "Perform a mouse drag from one coordinate to another on a target app.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "app": [
                        "type": "string",
                        "description": "App name, bundle identifier, or PID."
                    ],
                    "fromX": [
                        "type": "number",
                        "description": "Start X coordinate (global screen)."
                    ],
                    "fromY": [
                        "type": "number",
                        "description": "Start Y coordinate (global screen)."
                    ],
                    "toX": [
                        "type": "number",
                        "description": "End X coordinate (global screen)."
                    ],
                    "toY": [
                        "type": "number",
                        "description": "End Y coordinate (global screen)."
                    ],
                    "from_x": [
                        "type": "number",
                        "description": "Start X coordinate (global screen)."
                    ],
                    "from_y": [
                        "type": "number",
                        "description": "Start Y coordinate (global screen)."
                    ],
                    "to_x": [
                        "type": "number",
                        "description": "End X coordinate (global screen)."
                    ],
                    "to_y": [
                        "type": "number",
                        "description": "End Y coordinate (global screen)."
                    ]
                ],
                "required": ["app"],
                "additionalProperties": false
            ]
        ],
        [
            "name": "press_element",
            "description": "Perform AXPress, or another supported AX action, on a previously located UI element.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "pid": [
                        "type": "integer",
                        "description": "Target macOS process identifier."
                    ],
                    "windowIndex": [
                        "type": "integer",
                        "description": "Window index returned by find_ui_element."
                    ],
                    "path": [
                        "type": "array",
                        "items": [
                            "type": "integer"
                        ],
                        "description": "Child-index path returned by find_ui_element. Use [] or omit to target the window root."
                    ],
                    "action": [
                        "type": "string",
                        "description": "Optional AX action name such as AXPress."
                    ]
                ],
                "required": ["pid", "windowIndex"],
                "additionalProperties": false
            ]
        ]
    ]

    func run() async throws {
        while let body = try transport.readMessage() {
            guard !body.isEmpty else {
                continue
            }

            HandshakeLog.log("recv \(body.count) bytes")
            let payload = try JSONSerialization.jsonObject(with: body)
            guard let request = payload as? [String: Any] else {
                continue
            }

            let method = request["method"] as? String ?? "?"
            HandshakeLog.log("dispatch method=\(method) id=\(request["id"] ?? "nil")")
            if let response = try await handle(request: request) {
                try transport.writeMessage(jsonObject: response)
                HandshakeLog.log("sent response for method=\(method)")
            } else {
                HandshakeLog.log("no response for method=\(method) (notification)")
            }
        }
    }

    private func handle(request: [String: Any]) async throws -> [String: Any]? {
        guard let method = request["method"] as? String else {
            throw RPCError.invalidRequest("Missing JSON-RPC method.")
        }

        let id = request["id"]

        switch method {
        case "initialize":
            return makeResult(
                id: id,
                result: [
                    "protocolVersion": initializeProtocolVersion(from: request),
                    "capabilities": [
                        "tools": [:]
                    ],
                    "serverInfo": [
                        "name": "claudex-computer-use",
                        "version": ClaudexComputerUseVersion.current
                    ]
                ]
            )
        case "ping":
            return makeResult(id: id, result: [:])
        case "notifications/initialized":
            return nil
        case "notifications/cancelled":
            if let params = request["params"] as? [String: Any],
               let requestId = params["requestId"] {
                cancelledRequestIDs.insert(String(describing: requestId))
            }
            return nil
        case "tools/list":
            return makeResult(id: id, result: ["tools": Self.tools])
        case "tools/call":
            guard id != nil else {
                return nil
            }

            do {
                let result = try await handleToolCall(request)
                return makeResult(id: id, result: result)
            } catch {
                let codexError = CodexCompat.mapErrorToCodexStyle(error)
                return makeResult(
                    id: id,
                    result: [
                        "content": [
                            [
                                "type": "text",
                                "text": codexError
                            ]
                        ],
                        "isError": true,
                        "structuredContent": [
                            "error": codexError
                        ]
                    ]
                )
            }
        default:
            if method.hasPrefix("notifications/") {
                return nil
            }

            return makeError(id: id, code: -32601, message: "Method not found: \(method)")
        }
    }

    private func handleToolCall(_ request: [String: Any]) async throws -> [String: Any] {
        let params = request["params"] as? [String: Any] ?? [:]
        guard let name = params["name"] as? String else {
            throw ToolCallError.invalidArguments("Missing tool name.")
        }

        let arguments = params["arguments"] as? [String: Any] ?? [:]

        // Lazy-init NSApplication on first tool call (not at startup, to avoid blocking MCP handshake)
        AppBootstrap.ensureInitialized()

        switch name {
        case "get_app_state":
            let appIdent = try requiredString(arguments, key: "app")
            let resolved = try AppResolver.resolve(appIdent)
            let result = try AppStateService.getAppState(pid: resolved.pid)
            session.store(result.snapshot, elementRefs: result.elementRefs)
            let guidance = AppGuidance.guidance(
                bundleIdentifier: result.snapshot.bundleIdentifier,
                localizedName: result.snapshot.app,
                snapshot: result.snapshot
            )
            let focusedIdx = CodexCompat.detectFocusedElementIndex(pid: resolved.pid, snapshot: result.snapshot)
            let desktopStatus = DesktopSessionManager.status()
            let virtualCursor = VirtualCursor.currentStatus()

            // Codex-compatible envelope
            let envelope = CodexCompat.renderEnvelope(
                snapshot: result.snapshot,
                guidance: guidance,
                focusedElementIndex: focusedIdx
            )

            var content: [[String: Any]] = [
                ["type": "text", "text": envelope]
            ]
            if let screenshot = result.screenshot {
                content.append([
                    "type": "image",
                    "data": screenshot.pngData.base64EncodedString(),
                    "mimeType": "image/png"
                ])
            }
            return [
                "content": content,
                "structuredContent": try Self.jsonObject(
                    from: AppStateToolResult(
                        snapshot: result.snapshot,
                        guidance: guidance,
                        screenshot: result.screenshot?.metadata,
                        desktopSession: desktopStatus,
                        virtualCursor: virtualCursor
                    )
                )
            ]

        case "acquire_desktop":
            let mode = try optionalDesktopSessionMode(arguments["mode"]) ?? .shared
            let actionBudget = optionalInt(arguments["action_budget"])
            if let actionBudget, actionBudget <= 0 {
                throw ToolCallError.invalidArguments("action_budget must be greater than 0.")
            }
            if let appIdent = optionalString(arguments["app"]) {
                let resolved = try AppResolver.resolve(appIdent)
                try activateApp(pid: resolved.pid)
            }
            let status = try DesktopSessionManager.acquire(
                mode: mode,
                actionBudget: actionBudget
            )
            OverlayCursorController.shared.beginDesktopSession(
                targetPID: status.currentFrontmostPID ?? status.frontmostPIDAtAcquire
            )
            return try makeStructuredToolResult(
                value: status,
                summary: "Desktop session acquired: \(mode.rawValue). Active app baseline: \(status.frontmostAppAtAcquire ?? "unknown")."
            )

        case "desktop_status":
            let status = DesktopSessionManager.status()
            let summary: String
            if status.active {
                summary = "Desktop session active: \(status.mode?.rawValue ?? "unknown"), actions used \(status.actionsUsed)\(status.actionBudget.map { "/\($0)" } ?? "")."
            } else if status.externalExclusiveLock {
                summary = "No local desktop session, but another Claudex Computer Use process holds the exclusive desktop lock."
            } else {
                summary = "No active desktop session."
            }
            return try makeStructuredToolResult(value: status, summary: summary)

        case "release_desktop":
            let status = DesktopSessionManager.release()
            OverlayCursorController.shared.endDesktopSession()
            return try makeStructuredToolResult(
                value: status,
                summary: "Desktop session released."
            )

        case "get_virtual_cursor":
            let status = VirtualCursor.currentStatus()
            let desktopState = status.desktopOverlayVisible ? "visible" : (status.desktopOverlayReady ? "ready" : "idle")
            return try makeStructuredToolResult(
                value: status,
                summary: "Virtual cursor mode: \(status.config.mode.rawValue), style: \(status.config.style.rawValue), trail: \(status.config.showTrail ? "on" : "off"), buffered marks: \(status.totalMarkCount), desktop overlay: \(status.desktopOverlayDriver) / \(desktopState), legacy helper: \(status.overlayHelperRunning ? "running" : "idle")."
            )

        case "set_virtual_cursor":
            let preset = try optionalVirtualCursorPreset(arguments["preset"])
            let mode = try optionalVirtualCursorMode(arguments["mode"])
            let style = try optionalVirtualCursorStyle(arguments["style"])
            let showTrail = optionalBool(arguments["show_trail"])
            let trailLimit = optionalInt(arguments["trail_limit"])
            if let trailLimit, trailLimit <= 0 {
                throw ToolCallError.invalidArguments("trail_limit must be greater than 0.")
            }
            let maxAgeSeconds = optionalDouble(arguments["max_age_seconds"])
            if let maxAgeSeconds, maxAgeSeconds <= 0 {
                throw ToolCallError.invalidArguments("max_age_seconds must be greater than 0.")
            }
            let clear = optionalBool(arguments["clear"]) ?? false
            let status = VirtualCursor.updateConfig(
                preset: preset,
                mode: mode,
                style: style,
                showTrail: showTrail,
                trailLimit: trailLimit,
                maxAgeSeconds: maxAgeSeconds,
                clear: clear
            )
            let desktopState = status.desktopOverlayVisible ? "visible" : (status.desktopOverlayReady ? "ready" : "idle")
            return try makeStructuredToolResult(
                value: status,
                summary: "Virtual cursor updated: \(preset?.rawValue ?? "custom"), mode \(status.config.mode.rawValue), style \(status.config.style.rawValue), trail \(status.config.showTrail ? "on" : "off"), max age \(Int(status.config.maxAgeSeconds))s, desktop overlay \(status.desktopOverlayDriver) / \(desktopState)."
            )

        case "press_key":
            let appIdent = try requiredString(arguments, key: "app")
            let key = try requiredString(arguments, key: "key")
            let resolved = try AppResolver.resolve(appIdent)
            let deliveryMode = try optionalInteractionDeliveryMode(arguments["delivery"]) ?? .background
            let restoreFocus = optionalBool(arguments["restore_focus"]) ?? (deliveryMode == .direct)

            try DesktopSessionManager.recordMutation(tool: "press_key")
            let result = try KeyInjector.pressKey(
                pid: resolved.pid,
                key: key,
                deliveryMode: deliveryMode,
                restoreFocus: restoreFocus
            )
            if let point = focusTargetPoint(pid: resolved.pid) {
                VirtualCursor.record(
                    pid: resolved.pid,
                    appName: resolved.localizedName,
                    point: point,
                    kind: "press_key",
                    accuracy: .inferred
                )
            }
            let modStr = result.modifiers.isEmpty ? "" : result.modifiers.joined(separator: "+") + "+"
            // Return post-action state (Codex compat)
            return try codexMutationResponse(
                pid: resolved.pid,
                appIdent: appIdent,
                actionSummary: "Pressed \(modStr)\(result.key) in \(result.appName ?? "unknown") (PID=\(result.pid))."
            )

        case "doctor":
            let shouldPrompt = optionalBool(arguments["prompt"]) ?? false
            let report = Diagnostics.doctor(
                promptForAccessibility: shouldPrompt,
                promptForScreenRecording: shouldPrompt
            )
            return try makeStructuredToolResult(
                value: report,
                summary: """
                Claudex Computer Use \(report.version)
                Accessibility: \(report.permissions.accessibilityTrusted ? "granted" : "missing")
                Screen Recording: \(report.permissions.screenRecordingTrusted ? "granted" : "missing")
                Running apps seen: \(report.runningAppCount)
                Allowlist: \(report.allowlistMode) (allowed: \(report.allowedBundleIDCount), denied: \(report.deniedBundleIDCount))
                Desktop session: \(report.desktopSession.active ? report.desktopSession.mode?.rawValue ?? "active" : (report.desktopSession.externalExclusiveLock ? "externally locked" : "idle"))
                Virtual cursor: \(report.virtualCursor.config.mode.rawValue)/\(report.virtualCursor.config.style.rawValue) (trail: \(report.virtualCursor.config.trailLimit))
                """
            )
        case "list_apps":
            let includeBackground = optionalBool(arguments["includeBackground"]) ?? false
            let apps = AppDiscovery.listRunningApps(includeBackground: includeBackground)
            let richText = CodexCompat.renderAppList(apps)
            return [
                "content": [
                    ["type": "text", "text": richText]
                ],
                "structuredContent": try Self.jsonObject(from: ["apps": apps])
            ]
        case "click":
            // Resolve PID: prefer "app" parameter, fall back to legacy "pid"
            let pid: Int32
            let resolvedAppName: String?
            if let appIdent = optionalString(arguments["app"]) {
                let resolved = try AppResolver.resolve(appIdent)
                pid = resolved.pid
                resolvedAppName = resolved.localizedName
            } else {
                pid = try requiredInt32(arguments, key: "pid")
                resolvedAppName = NSRunningApplication(processIdentifier: pid)?.localizedName
            }
            let clickCount = optionalInt(arguments["click_count"]) ?? 1
            guard clickCount > 0 else {
                throw ToolCallError.invalidArguments("click_count must be greater than 0.")
            }
            let mouseButton = try optionalMouseButton(arguments["mouse_button"]) ?? .left
            let clickDelivery = try optionalInteractionDeliveryMode(arguments["delivery"]) ?? .background
            let clickRestoreFocus = optionalBool(arguments["restore_focus"]) ?? true

            let appIdentForCompat = optionalString(arguments["app"]) ?? "PID=\(pid)"

            // Element index click (AX press via snapshot)
            if let elementIndex = optionalIntCoerced(arguments["element_index"]) {
                let resolved = try session.resolveElementIndex(pid: pid, elementIndex: elementIndex)
                let element: AppStateElement
                switch resolved {
                case .directRef(_, let resolvedElement):
                    element = resolvedElement
                case .locator(_, _, let resolvedElement):
                    element = resolvedElement
                }
                try DesktopSessionManager.recordMutation(tool: "click")

                if mouseButton != .left || clickCount != 1 {
                    guard let point = centerPoint(for: element) else {
                        throw ToolCallError.invalidArguments(
                            "Element \(elementIndex) does not expose a frame, so non-default coordinate click options are unavailable."
                        )
                    }
                    OverlayCursorController.shared.animate(
                        to: CGPoint(x: point.x, y: point.y),
                        accuracy: .coordinate,
                        style: VirtualCursor.currentConfig().style,
                        kind: "click",
                        targetPID: pid
                    )
                    _ = try InputInjector.click(
                        pid: pid,
                        at: point,
                        button: mouseButton,
                        clickCount: clickCount,
                        deliveryMode: clickDelivery,
                        restoreFocus: clickRestoreFocus
                    )
                    OverlayCursorController.shared.pulse()
                    VirtualCursor.record(
                        pid: pid,
                        appName: resolvedAppName,
                        point: point,
                        kind: "click.element",
                        accuracy: .coordinate
                    )
                    return try codexMutationResponse(
                        pid: pid,
                        appIdent: appIdentForCompat,
                        actionSummary: "Clicked element \(elementIndex) at (\(point.x), \(point.y)) using \(mouseButton.rawValue) x\(clickCount)."
                    )
                }

                // Animate live cursor to element BEFORE pressing
                if let animPoint = centerPoint(for: element) {
                    let acc = semanticCursorAccuracy(pid: pid)
                    OverlayCursorController.shared.animate(
                        to: CGPoint(x: animPoint.x, y: animPoint.y),
                        accuracy: acc,
                        style: VirtualCursor.currentConfig().style,
                        kind: "click.element",
                        targetPID: pid
                    )
                }

                let pressResult: UIElementPressResult
                switch resolved {
                case .directRef(let axElement, let element):
                    // Direct AX element ref (menu bar items, etc.)
                    let actions = try performDirectAction(axElement, preferredAction: nil)
                    pressResult = UIElementPressResult(
                        pid: pid,
                        appName: session.snapshot(for: pid)?.app,
                        windowIndex: element.windowIndex,
                        path: element.path,
                        role: element.role,
                        title: element.title,
                        action: actions
                    )
                case .locator(let windowIndex, let path, _):
                    pressResult = try UIElementService.pressElement(
                        pid: pid,
                        windowIndex: windowIndex,
                        path: path
                    )
                }
                OverlayCursorController.shared.pulse()
                if let point = centerPoint(for: element) {
                    VirtualCursor.record(
                        pid: pid,
                        appName: resolvedAppName,
                        point: point,
                        kind: "click.element",
                        accuracy: semanticCursorAccuracy(pid: pid)
                    )
                }
                return try codexMutationResponse(
                    pid: pid,
                    appIdent: appIdentForCompat,
                    actionSummary: "Clicked element \(elementIndex): \(pressResult.role ?? "element") '\(pressResult.title ?? "(untitled)")'."
                )
            }

            // Coordinate click
            let x = try requiredDouble(arguments, key: "x")
            let y = try requiredDouble(arguments, key: "y")
            try DesktopSessionManager.recordMutation(tool: "click")
            OverlayCursorController.shared.animate(
                to: CGPoint(x: x, y: y),
                accuracy: .coordinate,
                style: VirtualCursor.currentConfig().style,
                kind: "click",
                targetPID: pid
            )
            let result = try InputInjector.click(
                pid: pid,
                at: ScreenPoint(x: x, y: y),
                button: mouseButton,
                clickCount: clickCount,
                deliveryMode: clickDelivery,
                restoreFocus: clickRestoreFocus
            )
            OverlayCursorController.shared.pulse()
            VirtualCursor.record(
                pid: pid,
                appName: resolvedAppName,
                point: result.point,
                kind: "click",
                accuracy: .coordinate
            )
            return try codexMutationResponse(
                pid: pid,
                appIdent: appIdentForCompat,
                actionSummary: "Click dispatched at (\(result.point.x), \(result.point.y)) using \(mouseButton.rawValue) x\(clickCount), delivery=\(result.deliveryMethod). Verify the resulting app state; event dispatch alone does not establish the intended effect."
            )
        case "scroll":
            let pid: Int32
            if let appIdent = optionalString(arguments["app"]) {
                pid = try AppResolver.resolve(appIdent).pid
            } else {
                pid = try requiredInt32(arguments, key: "pid")
            }
            let direction = try requiredScrollDirection(arguments, key: "direction")

            // pages overrides amount (1 page = 12 lines)
            let amount: Int
            if let pages = optionalInt(arguments["pages"]) {
                amount = pages * 12
            } else {
                amount = optionalInt(arguments["amount"]) ?? 3
            }

            // Determine scroll target point
            var scrollPoint: ScreenPoint? = nil
            if let elementIndex = optionalIntCoerced(arguments["element_index"]) {
                // Use element center as scroll target
                let resolvedEl = try session.resolveElementIndex(pid: pid, elementIndex: elementIndex)
                let element: AppStateElement
                switch resolvedEl {
                case .directRef(_, let el): element = el
                case .locator(_, _, let el): element = el
                }
                if let frame = element.frame {
                    scrollPoint = ScreenPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
                }
            } else {
                let x = optionalDouble(arguments["x"])
                let y = optionalDouble(arguments["y"])
                if (x == nil) != (y == nil) {
                    throw ToolCallError.invalidArguments("scroll expects both x and y when specifying a target point.")
                }
                scrollPoint = makeOptionalPoint(x: x, y: y)
            }

            try DesktopSessionManager.recordMutation(tool: "scroll")
            if let sp = scrollPoint {
                OverlayCursorController.shared.animate(
                    to: CGPoint(x: sp.x, y: sp.y),
                    accuracy: .coordinate,
                    style: VirtualCursor.currentConfig().style,
                    kind: "scroll",
                    targetPID: pid
                )
            }
            let result = try InputInjector.scroll(
                pid: pid,
                direction: direction,
                amount: amount,
                at: scrollPoint
            )
            if let point = result.targetPoint {
                VirtualCursor.record(
                    pid: pid,
                    appName: NSRunningApplication(processIdentifier: pid)?.localizedName,
                    point: point,
                    kind: "scroll",
                    accuracy: .coordinate
                )
            }
            let scrollAppIdent = optionalString(arguments["app"]) ?? "PID=\(pid)"
            return try codexMutationResponse(
                pid: pid,
                appIdent: scrollAppIdent,
                actionSummary: "Injected scroll \(result.direction.rawValue) x\(result.amount) into \(result.appName ?? "unknown")."
            )
        case "list_windows":
            let shouldPrompt = optionalBool(arguments["prompt"]) ?? false
            if shouldPrompt {
                _ = PermissionManager.screenRecordingTrusted(prompt: true)
            }

            let pid = optionalInt32(arguments["pid"])
            let windows = try WindowCapture.listWindows(pid: pid)
            return try makeStructuredToolResult(
                value: ["windows": windows],
                summary: "Found \(windows.count) captureable window(s)."
            )
        case "capture_window":
            let pid = try requiredInt32(arguments, key: "pid")
            let windowID = optionalUInt32(arguments["windowId"])
            let scale = optionalDouble(arguments["scale"]) ?? 1.0
            let shouldPrompt = optionalBool(arguments["prompt"]) ?? false
            let capture = try WindowCapture.captureWindow(
                pid: pid,
                windowID: windowID,
                scale: scale,
                promptForScreenRecording: shouldPrompt
            )
            let summary = """
            Captured window \(capture.metadata.window.windowID) from \(capture.metadata.window.appName ?? "unknown") as PNG.
            Size: \(capture.metadata.pixelWidth)x\(capture.metadata.pixelHeight), backend: \(capture.metadata.captureBackend), virtual cursor: \(capture.metadata.virtualCursorApplied ? "overlayed" : "off")
            """
            return try makeImageToolResult(capture: capture, summary: summary)
        case "type_text":
            let pid: Int32
            let resolvedAppName: String?
            if let appIdent = optionalString(arguments["app"]) {
                let resolved = try AppResolver.resolve(appIdent)
                pid = resolved.pid
                resolvedAppName = resolved.localizedName
            } else {
                pid = try requiredInt32(arguments, key: "pid")
                resolvedAppName = NSRunningApplication(processIdentifier: pid)?.localizedName
            }
            let text = try requiredString(arguments, key: "text")
            let strategy = try optionalTextInjectionStrategy(arguments["strategy"]) ?? .auto
            let deliveryMode = try optionalInteractionDeliveryMode(arguments["delivery"]) ?? .background
            let restoreFocus = optionalBool(arguments["restore_focus"]) ?? (deliveryMode == .direct)
            try DesktopSessionManager.recordMutation(tool: "type_text")
            let result = try InputInjector.typeText(
                pid: pid,
                text: text,
                strategy: strategy,
                deliveryMode: deliveryMode,
                restoreFocus: restoreFocus
            )
            if let point = focusTargetPoint(pid: pid) {
                VirtualCursor.record(
                    pid: pid,
                    appName: resolvedAppName,
                    point: point,
                    kind: "type_text",
                    accuracy: .inferred
                )
            }
            let typeAppIdent = optionalString(arguments["app"]) ?? "PID=\(pid)"
            return try codexMutationResponse(
                pid: pid,
                appIdent: typeAppIdent,
                actionSummary: "Injected \(result.charactersSent) character(s) into \(result.appName ?? "unknown")."
            )
        case "set_value":
            let value = try requiredUIElementValue(arguments, key: "value")
            let result: UIElementSetValueResult
            let pid: Int32
            var virtualCursorPoint: ScreenPoint?
            var appNameForOverlay: String?
            if let appIdent = optionalString(arguments["app"]),
               let elementIndex = optionalIntCoerced(arguments["element_index"]) {
                let resolved = try AppResolver.resolve(appIdent)
                pid = resolved.pid
                appNameForOverlay = resolved.localizedName
                let resolvedElement = try session.resolveElementIndex(pid: pid, elementIndex: elementIndex)
                switch resolvedElement {
                case .directRef(let axElement, let element):
                    virtualCursorPoint = centerPoint(for: element)
                    try DesktopSessionManager.recordMutation(tool: "set_value")
                    result = try UIElementService.setValue(
                        pid: pid,
                        element: axElement,
                        windowIndex: element.windowIndex,
                        path: element.path,
                        value: value
                    )
                case .locator(let windowIndex, let path, let element):
                    virtualCursorPoint = centerPoint(for: element)
                    try DesktopSessionManager.recordMutation(tool: "set_value")
                    result = try UIElementService.setValue(
                        pid: pid,
                        windowIndex: windowIndex,
                        path: path,
                        value: value
                    )
                }
            } else {
                pid = try requiredInt32(arguments, key: "pid")
                let windowIndex = try requiredInt(arguments, key: "windowIndex")
                let path = try optionalIntArray(arguments["path"]) ?? []
                appNameForOverlay = NSRunningApplication(processIdentifier: pid)?.localizedName
                try DesktopSessionManager.recordMutation(tool: "set_value")
                result = try UIElementService.setValue(
                    pid: pid,
                    windowIndex: windowIndex,
                    path: path,
                    value: value
                )
            }
            if let virtualCursorPoint {
                VirtualCursor.record(
                    pid: pid,
                    appName: appNameForOverlay,
                    point: virtualCursorPoint,
                    kind: "set_value",
                    accuracy: .inferred
                )
            }
            let setValueAppIdent = optionalString(arguments["app"]) ?? "PID=\(pid)"
            let summary = """
            Set AXValue on \(result.role ?? "unknown role") '\(result.title ?? "(untitled)")'.
            Locator: windowIndex=\(result.windowIndex), path=\(result.path.map(String.init).joined(separator: ","))
            """
            return try codexMutationResponse(pid: pid, appIdent: setValueAppIdent, actionSummary: summary)
        case "stop":
            cancelledRequestIDs.removeAll()
            return try makeStructuredToolResult(
                value: ["stopped": true],
                summary: "Claudex Computer Use acknowledged stop signal."
            )
        case "get_allowlist":
            let config = Allowlist.currentConfig()
            return try makeStructuredToolResult(
                value: config,
                summary: "Allowlist mode: \(config.mode.rawValue), allowed: \(config.allowedBundleIDs.count), denied: \(config.deniedBundleIDs.count)"
            )
        case "set_allowlist":
            var config = Allowlist.currentConfig()
            if let modeStr = optionalString(arguments["mode"]) {
                guard let mode = AllowlistMode(rawValue: modeStr) else {
                    throw ToolCallError.invalidArguments("mode must be 'allowAll' or 'allowlistOnly'.")
                }
                config.mode = mode
            }
            if let allowed = arguments["allowedBundleIDs"] as? [String] {
                config.allowedBundleIDs = Set(allowed)
            }
            if let denied = arguments["deniedBundleIDs"] as? [String] {
                config.deniedBundleIDs = Set(denied)
            }
            Allowlist.load(config)
            let persist = optionalBool(arguments["persist"]) ?? false
            if persist {
                let url = Allowlist.defaultConfigURL()
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try Allowlist.saveToFile(config, url: url)
            }
            return try makeStructuredToolResult(
                value: config,
                summary: "Allowlist updated. Mode: \(config.mode.rawValue), allowed: \(config.allowedBundleIDs.count), denied: \(config.deniedBundleIDs.count)\(persist ? " (persisted)" : "")"
            )
        case "perform_action", "perform_secondary_action":
            let appIdent = try requiredString(arguments, key: "app")
            guard let elementIndex = optionalIntCoerced(arguments["element_index"]) else {
                throw ToolCallError.invalidArguments("Expected 'element_index'.")
            }
            let action = try requiredString(arguments, key: "action")
            let resolved = try AppResolver.resolve(appIdent)
            let resolvedEl = try session.resolveElementIndex(pid: resolved.pid, elementIndex: elementIndex)
            let overlayPoint: ScreenPoint?
            switch resolvedEl {
            case .directRef(_, let element):
                overlayPoint = centerPoint(for: element)
            case .locator(_, _, let element):
                overlayPoint = centerPoint(for: element)
            }

            try DesktopSessionManager.recordMutation(tool: "perform_action")
            let actionResult: String
            switch resolvedEl {
            case .directRef(let axElement, _):
                actionResult = try performDirectAction(axElement, preferredAction: action)
            case .locator(let windowIndex, let path, _):
                let r = try UIElementService.pressElement(
                    pid: resolved.pid,
                    windowIndex: windowIndex,
                    path: path,
                    action: action
                )
                actionResult = r.action
            }
            if let overlayPoint {
                VirtualCursor.record(
                    pid: resolved.pid,
                    appName: resolved.localizedName,
                    point: overlayPoint,
                    kind: "perform_action",
                    accuracy: semanticCursorAccuracy(pid: resolved.pid)
                )
            }
            return try codexMutationResponse(
                pid: resolved.pid,
                appIdent: appIdent,
                actionSummary: "Performed \(actionResult) on element \(elementIndex)."
            )

        case "drag":
            let appIdent = try requiredString(arguments, key: "app")
            let resolved = try AppResolver.resolve(appIdent)
            let fromX = try requiredDouble(arguments, keys: ["fromX", "from_x"])
            let fromY = try requiredDouble(arguments, keys: ["fromY", "from_y"])
            let toX = try requiredDouble(arguments, keys: ["toX", "to_x"])
            let toY = try requiredDouble(arguments, keys: ["toY", "to_y"])
            try DesktopSessionManager.recordMutation(tool: "drag")
            let cursorStyle = VirtualCursor.currentConfig().style
            OverlayCursorController.shared.animate(
                to: CGPoint(x: fromX, y: fromY),
                accuracy: .coordinate,
                style: cursorStyle,
                kind: "drag.start",
                targetPID: resolved.pid
            )
            let result = try InputInjector.drag(
                pid: resolved.pid,
                from: ScreenPoint(x: fromX, y: fromY),
                to: ScreenPoint(x: toX, y: toY)
            )
            OverlayCursorController.shared.animate(
                to: CGPoint(x: toX, y: toY),
                accuracy: .coordinate,
                style: cursorStyle,
                kind: "drag.end",
                targetPID: resolved.pid
            )
            VirtualCursor.record(
                pid: resolved.pid,
                appName: resolved.localizedName,
                point: result.from,
                kind: "drag.start",
                accuracy: .coordinate
            )
            VirtualCursor.record(
                pid: resolved.pid,
                appName: resolved.localizedName,
                point: result.to,
                kind: "drag.end",
                accuracy: .coordinate
            )
            return try codexMutationResponse(
                pid: resolved.pid,
                appIdent: appIdent,
                actionSummary: "Dragged from (\(fromX),\(fromY)) to (\(toX),\(toY)) in \(result.appName ?? "unknown")."
            )

        case "find_ui_element":
            let pid = try requiredInt32(arguments, key: "pid")
            let role = optionalString(arguments["role"])
            let text = optionalString(arguments["text"])
            let title = optionalString(arguments["title"])
            let value = optionalString(arguments["value"])
            let elementDescription = optionalString(arguments["description"])
            let maxResults = optionalInt(arguments["maxResults"]) ?? 10
            let allWindows = optionalBool(arguments["allWindows"]) ?? true
            let result = try UIElementService.findUIElements(
                pid: pid,
                role: role,
                text: text,
                title: title,
                value: value,
                elementDescription: elementDescription,
                maxResults: maxResults,
                searchAllWindows: allWindows
            )
            let summary = """
            Found \(result.matches.count) matching UI element(s) in \(result.appName ?? "unknown") (PID=\(result.pid)).
            Scanned \(result.scannedElementCount) element(s) across \(result.searchedWindowCount) window(s).
            """
            return try makeStructuredToolResult(value: result, summary: summary)
        case "press_element":
            let pid = try requiredInt32(arguments, key: "pid")
            let windowIndex = try requiredInt(arguments, key: "windowIndex")
            let path = try optionalIntArray(arguments["path"]) ?? []
            let action = optionalString(arguments["action"])
            try DesktopSessionManager.recordMutation(tool: "press_element")
            let result = try UIElementService.pressElement(
                pid: pid,
                windowIndex: windowIndex,
                path: path,
                action: action
            )
            let summary = """
            Performed \(result.action) on \(result.role ?? "unknown role") '\(result.title ?? "(untitled)")'.
            Locator: windowIndex=\(result.windowIndex), path=\(result.path.map(String.init).joined(separator: ","))
            """
            return try makeStructuredToolResult(value: result, summary: summary)
        default:
            throw ToolCallError.invalidArguments("Unknown tool '\(name)'.")
        }
    }

    private func performDirectAction(_ element: AXUIElement, preferredAction: String?) throws -> String {
        var actions: CFArray?
        AXUIElementCopyActionNames(element, &actions)
        let available = (actions as? [String]) ?? []

        let action: String
        if let preferred = preferredAction, available.contains(preferred) {
            action = preferred
        } else if available.contains("AXPress") {
            action = "AXPress"
        } else if let first = available.first {
            action = first
        } else {
            throw ToolCallError.invalidArguments("Element has no available actions.")
        }

        let error = AXUIElementPerformAction(element, action as CFString)
        guard error == .success else {
            throw ToolCallError.invalidArguments("AX action '\(action)' failed with error \(error.rawValue).")
        }
        return action
    }

    private func resolveAppPid(_ arguments: [String: Any]) throws -> Int32 {
        if let appIdent = optionalString(arguments["app"]) {
            return try AppResolver.resolve(appIdent).pid
        }
        return try requiredInt32(arguments, key: "pid")
    }

    // MARK: - Codex compat helpers

    /// Parse element_index from either integer or string (Codex sends strings).
    private func optionalIntCoerced(_ value: Any?) -> Int? {
        if let number = value as? NSNumber {
            return number.intValue
        }
        if let str = value as? String, let parsed = Int(str) {
            return parsed
        }
        return nil
    }

    /// After a mutation, re-snapshot the app and return a Codex-style envelope with post-action state.
    /// If re-snapshot fails, returns a minimal text result.
    private func codexMutationResponse(
        pid: Int32,
        appIdent: String,
        actionSummary: String
    ) throws -> [String: Any] {
        // Check for hard interference: target process gone
        guard NSRunningApplication(processIdentifier: pid) != nil else {
            session.invalidate(pid: pid)
            let warning = CodexCompat.renderStaleWarning(appName: appIdent)
            return [
                "content": [
                    ["type": "text", "text": warning]
                ]
            ]
        }

        // Re-snapshot
        do {
            let result = try AppStateService.getAppState(pid: pid)
            session.store(result.snapshot, elementRefs: result.elementRefs)

            let guidance = AppGuidance.guidance(
                bundleIdentifier: result.snapshot.bundleIdentifier,
                localizedName: result.snapshot.app,
                snapshot: result.snapshot
            )
            let focusedIdx = CodexCompat.detectFocusedElementIndex(pid: pid, snapshot: result.snapshot)
            let envelope = CodexCompat.renderEnvelope(
                snapshot: result.snapshot,
                guidance: guidance,
                focusedElementIndex: focusedIdx
            )

            var content: [[String: Any]] = [
                ["type": "text", "text": envelope]
            ]
            if let screenshot = result.screenshot {
                content.append([
                    "type": "image",
                    "data": screenshot.pngData.base64EncodedString(),
                    "mimeType": "image/png"
                ])
            }
            // Preserve structuredContent for non-Codex harnesses
            let structured = try Self.jsonObject(from: AppStateToolResult(
                snapshot: result.snapshot,
                guidance: guidance,
                screenshot: result.screenshot?.metadata,
                desktopSession: DesktopSessionManager.status(),
                virtualCursor: VirtualCursor.currentStatus()
            ))
            return [
                "content": content,
                "structuredContent": structured
            ]
        } catch {
            // Re-snapshot failed — return action summary only
            return [
                "content": [
                    ["type": "text", "text": actionSummary]
                ]
            ]
        }
    }

    private func initializeProtocolVersion(from request: [String: Any]) -> String {
        let params = request["params"] as? [String: Any]
        return params?["protocolVersion"] as? String ?? "2025-03-26"
    }

    private func requiredInt32(_ arguments: [String: Any], key: String) throws -> Int32 {
        guard let value = arguments[key] as? NSNumber else {
            throw ToolCallError.invalidArguments("Expected numeric '\(key)'.")
        }
        return value.int32Value
    }

    private func requiredDouble(_ arguments: [String: Any], key: String) throws -> Double {
        guard let value = arguments[key] as? NSNumber else {
            throw ToolCallError.invalidArguments("Expected numeric '\(key)'.")
        }
        return value.doubleValue
    }

    private func requiredDouble(_ arguments: [String: Any], keys: [String]) throws -> Double {
        for key in keys {
            if let value = optionalDouble(arguments[key]) {
                return value
            }
        }
        throw ToolCallError.invalidArguments("Expected numeric '\(keys.joined(separator: "' or '"))'.")
    }

    private func requiredInt(_ arguments: [String: Any], key: String) throws -> Int {
        guard let value = arguments[key] as? NSNumber else {
            throw ToolCallError.invalidArguments("Expected integer '\(key)'.")
        }
        return value.intValue
    }

    private func requiredScrollDirection(_ arguments: [String: Any], key: String) throws -> ScrollDirection {
        let rawValue = try requiredString(arguments, key: key).lowercased()
        guard let direction = ScrollDirection(rawValue: rawValue) else {
            throw ToolCallError.invalidArguments("Expected scroll direction '\(key)' to be one of up, down, left, or right.")
        }
        return direction
    }

    private func requiredUIElementValue(_ arguments: [String: Any], key: String) throws -> UIElementValueInput {
        guard let value = arguments[key] else {
            throw ToolCallError.invalidArguments("Missing '\(key)'.")
        }

        switch value {
        case let string as String:
            return .string(string)
        case let bool as Bool:
            return .bool(bool)
        case let number as NSNumber:
            return .number(number.doubleValue)
        default:
            throw ToolCallError.invalidArguments("Expected '\(key)' to be a string, number, or boolean.")
        }
    }

    private func optionalMouseButton(_ value: Any?) throws -> MouseButton? {
        guard let raw = optionalString(value)?.lowercased() else {
            return nil
        }
        guard let button = MouseButton(rawValue: raw) else {
            throw ToolCallError.invalidArguments("mouse_button must be one of left, right, or middle.")
        }
        return button
    }

    private func makeOptionalPoint(x: Double?, y: Double?) -> ScreenPoint? {
        guard let x, let y else {
            return nil
        }

        return ScreenPoint(x: x, y: y)
    }

    private func centerPoint(for element: AppStateElement) -> ScreenPoint? {
        guard let frame = element.frame else {
            return nil
        }
        return ScreenPoint(
            x: frame.x + frame.width / 2,
            y: frame.y + frame.height / 2
        )
    }

    private func currentGuidanceHint(pid: Int32) -> AppGuidanceHint {
        let snapshot = session.snapshot(for: pid)
        let app = NSRunningApplication(processIdentifier: pid)
        return AppGuidance.guidance(
            bundleIdentifier: app?.bundleIdentifier ?? snapshot?.bundleIdentifier,
            localizedName: app?.localizedName ?? snapshot?.app,
            snapshot: snapshot
        )
    }

    private func semanticCursorAccuracy(pid: Int32) -> VirtualCursorAccuracy {
        currentGuidanceHint(pid: pid).frameReliability == .low ? .approximate : .semantic
    }

    private func isTextInputElement(_ element: AppStateElement) -> Bool {
        element.settable && (
            element.role == "text field"
                || element.role == "text area"
                || element.role == "search text field"
                || element.role == "combo box"
        )
    }

    private func windowAnchorPoint(snapshot: AppStateSnapshot) -> ScreenPoint? {
        if let primaryWindow = snapshot.elements.first(where: {
            ($0.role == "window" || $0.role == "standard window") && $0.windowIndex == 0
        }), let point = centerPoint(for: primaryWindow) {
            return point
        }

        if let anyWindow = snapshot.elements.first(where: { $0.role == "window" || $0.role == "standard window" }) {
            return centerPoint(for: anyWindow)
        }

        return nil
    }

    /// Best-effort screen point for keyboard-targeted actions (type_text, press_key).
    /// Queries the live AX focused element first, then falls back to snapshot heuristics.
    private func focusTargetPoint(pid: Int32) -> ScreenPoint? {
        let guidance = currentGuidanceHint(pid: pid)
        let snapshot = session.snapshot(for: pid)

        // Weak-AX apps often expose the focused element but report misleading geometry.
        // For keyboard/value overlays, prefer a neutral window anchor over a fake precise cursor.
        if guidance.frameReliability != .low {
            let appElement = AXUIElementCreateApplication(pid)
            var focusedRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
               CFGetTypeID(focusedRef as CFTypeRef) == AXUIElementGetTypeID() {
                let focused = focusedRef as! AXUIElement
                var posValue: CFTypeRef?
                var sizeValue: CFTypeRef?
                if AXUIElementCopyAttributeValue(focused, kAXPositionAttribute as CFString, &posValue) == .success,
                   AXUIElementCopyAttributeValue(focused, kAXSizeAttribute as CFString, &sizeValue) == .success {
                    var pos = CGPoint.zero
                    var size = CGSize.zero
                    if AXValueGetValue(posValue as! AXValue, .cgPoint, &pos),
                       AXValueGetValue(sizeValue as! AXValue, .cgSize, &size),
                       size.width > 0, size.height > 0 {
                        return ScreenPoint(
                            x: Double(pos.x + size.width / 2),
                            y: Double(pos.y + size.height / 2)
                        )
                    }
                }
            }
        }

        guard let snapshot else {
            return nil
        }

        if guidance.frameReliability != .low,
           let textElement = snapshot.elements.first(where: isTextInputElement),
           let point = centerPoint(for: textElement) {
            return point
        }

        return windowAnchorPoint(snapshot: snapshot)
    }

    private func optionalInt32(_ value: Any?) -> Int32? {
        guard let number = value as? NSNumber else {
            return nil
        }
        return number.int32Value
    }

    private func optionalUInt32(_ value: Any?) -> UInt32? {
        guard let number = value as? NSNumber else {
            return nil
        }
        return number.uint32Value
    }

    private func optionalDouble(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber else {
            return nil
        }
        return number.doubleValue
    }

    private func optionalInt(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber else {
            return nil
        }
        return number.intValue
    }

    private func requiredString(_ arguments: [String: Any], key: String) throws -> String {
        guard let value = arguments[key] as? String else {
            throw ToolCallError.invalidArguments("Expected string '\(key)'.")
        }
        return value
    }

    private func optionalString(_ value: Any?) -> String? {
        guard let value = value as? String else {
            return nil
        }
        return value
    }

    private func optionalBool(_ value: Any?) -> Bool? {
        switch value {
        case let bool as Bool:
            return bool
        case let number as NSNumber:
            return number.boolValue
        default:
            return nil
        }
    }

    private func optionalIntArray(_ value: Any?) throws -> [Int]? {
        guard let value else {
            return nil
        }
        guard let array = value as? [Any] else {
            throw ToolCallError.invalidArguments("Expected integer array 'path'.")
        }

        return try array.map { item in
            guard let number = item as? NSNumber else {
                throw ToolCallError.invalidArguments("Expected integer array 'path'.")
            }
            return number.intValue
        }
    }

    private func optionalDesktopSessionMode(_ value: Any?) throws -> DesktopSessionMode? {
        guard let raw = optionalString(value) else {
            return nil
        }
        guard let mode = DesktopSessionMode(rawValue: raw) else {
            throw ToolCallError.invalidArguments("mode must be 'shared' or 'exclusive'.")
        }
        return mode
    }

    private func optionalVirtualCursorMode(_ value: Any?) throws -> VirtualCursorMode? {
        guard let raw = optionalString(value) else {
            return nil
        }
        guard let mode = VirtualCursorMode(rawValue: raw) else {
            throw ToolCallError.invalidArguments("mode must be 'off', 'screenshotOverlay', 'desktopOverlay', or 'hybrid'.")
        }
        return mode
    }

    private func optionalVirtualCursorPreset(_ value: Any?) throws -> VirtualCursorPreset? {
        guard let raw = optionalString(value) else {
            return nil
        }
        guard let preset = VirtualCursorPreset(rawValue: raw) else {
            throw ToolCallError.invalidArguments("preset must be 'codexDemo' or 'debugTrace'.")
        }
        return preset
    }

    private func optionalVirtualCursorStyle(_ value: Any?) throws -> VirtualCursorStyle? {
        guard let raw = optionalString(value) else {
            return nil
        }
        guard let style = VirtualCursorStyle(rawValue: raw) else {
            throw ToolCallError.invalidArguments("style must be 'crosshair', 'secondCursor', or 'ghostArrow'.")
        }
        return style
    }

    private func optionalInteractionDeliveryMode(_ value: Any?) throws -> InteractionDeliveryMode? {
        guard let raw = optionalString(value) else {
            return nil
        }
        guard let mode = InteractionDeliveryMode(rawValue: raw) else {
            throw ToolCallError.invalidArguments("delivery must be 'background' or 'direct'.")
        }
        return mode
    }

    private func optionalTextInjectionStrategy(_ value: Any?) throws -> TextInjectionStrategy? {
        guard let raw = optionalString(value) else {
            return nil
        }
        guard let strategy = TextInjectionStrategy(rawValue: raw) else {
            throw ToolCallError.invalidArguments("strategy must be 'auto', 'unicodeEvent', or 'pasteboard'.")
        }
        return strategy
    }

    private func activateApp(pid: Int32, settleDelay: TimeInterval = 0.15) throws {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            throw ClaudexComputerUseCoreError.processNotFound(pid)
        }
        let activated = app.activate(options: [.activateIgnoringOtherApps])
        guard activated else {
            throw ClaudexComputerUseCoreError.invalidArgument(
                "Failed to activate \(app.localizedName ?? "PID=\(pid)") before acquiring the desktop session."
            )
        }
        Thread.sleep(forTimeInterval: settleDelay)
    }

    private func makeStructuredToolResult<T: Encodable>(value: T, summary: String) throws -> [String: Any] {
        let object = try Self.jsonObject(from: value)
        return [
            "content": [
                [
                    "type": "text",
                    "text": summary
                ]
            ],
            "structuredContent": object
        ]
    }

    private func makeImageToolResult(capture: CapturedWindowImage, summary: String) throws -> [String: Any] {
        let metadata = try Self.jsonObject(from: capture.metadata)
        return [
            "content": [
                [
                    "type": "text",
                    "text": summary
                ],
                [
                    "type": "image",
                    "data": capture.pngData.base64EncodedString(),
                    "mimeType": "image/png"
                ]
            ],
            "structuredContent": metadata
        ]
    }

    private func makeResult(id: Any?, result: [String: Any]) -> [String: Any]? {
        guard let id else {
            return nil
        }

        return [
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        ]
    }

    private func makeError(id: Any?, code: Int, message: String) -> [String: Any]? {
        guard let id else {
            return nil
        }

        return [
            "jsonrpc": "2.0",
            "id": id,
            "error": [
                "code": code,
                "message": message
            ]
        ]
    }

    private static func jsonObject<T: Encodable>(from value: T) throws -> Any {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        return try JSONSerialization.jsonObject(with: data)
    }
}

/// Stdio transport that auto-detects framing format:
/// - NDJSON: `{...}\n` (MCP SDK >= 2025-11-25)
/// - Content-Length: `Content-Length: N\r\n\r\n{...}` (legacy)
private final class StdioTransport {
    private let input = FileHandle.standardInput
    private let output = FileHandle.standardOutput
    private var useNDJSON: Bool?

    func readMessage() throws -> Data? {
        // Read one line to determine framing on first call
        guard let firstLine = try readLine() else {
            return nil
        }

        // Auto-detect on first message
        if useNDJSON == nil {
            if firstLine.hasPrefix("{") {
                useNDJSON = true
                HandshakeLog.log("framing: NDJSON (detected from first byte)")
            } else {
                useNDJSON = false
                HandshakeLog.log("framing: Content-Length (detected from first byte)")
            }
        }

        if useNDJSON == true {
            // NDJSON: the line IS the message
            return firstLine.data(using: .utf8)
        }

        // Content-Length framing: firstLine is a header
        var contentLength: Int?
        var line: String? = firstLine

        while let current = line {
            if current.isEmpty {
                break
            }
            let parts = current.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2, parts[0].lowercased() == "content-length" {
                contentLength = Int(parts[1].trimmingCharacters(in: .whitespaces))
            }
            line = try readLine()
        }

        guard let contentLength else {
            throw RPCError.invalidRequest("Missing Content-Length header.")
        }

        return try readBody(length: contentLength)
    }

    func writeMessage(jsonObject: [String: Any]) throws {
        let body = try JSONSerialization.data(withJSONObject: jsonObject)

        if useNDJSON == true {
            output.write(body)
            output.write(Data([0x0A])) // \n
        } else {
            let header = "Content-Length: \(body.count)\r\n\r\n"
            output.write(header.data(using: .utf8)!)
            output.write(body)
        }
    }

    private func readLine() throws -> String? {
        var data = Data()

        while true {
            guard let chunk = try input.read(upToCount: 1), !chunk.isEmpty else {
                if data.isEmpty {
                    return nil
                }
                return String(data: data, encoding: .utf8)
            }

            if chunk[chunk.startIndex] == 0x0A { // \n
                // Strip trailing \r if present
                if !data.isEmpty, data.last == 0x0D {
                    data.removeLast()
                }
                return String(data: data, encoding: .utf8)
            }

            data.append(chunk)
        }
    }

    private func readBody(length: Int) throws -> Data {
        var remaining = length
        var data = Data()

        while remaining > 0 {
            guard let chunk = try input.read(upToCount: remaining), !chunk.isEmpty else {
                throw RPCError.invalidRequest("Unexpected EOF while reading JSON-RPC body.")
            }
            data.append(chunk)
            remaining -= chunk.count
        }

        return data
    }
}

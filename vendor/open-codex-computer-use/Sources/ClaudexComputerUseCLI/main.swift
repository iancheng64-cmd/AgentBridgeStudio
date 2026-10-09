import Foundation
import ClaudexComputerUseCore

enum CLIError: LocalizedError {
    case invalidUsage(String)

    var errorDescription: String? {
        switch self {
        case .invalidUsage(let message):
            return message
        }
    }
}

@main
struct ClaudexComputerUseCLI {
    static func main() async {
        do {
            AppBootstrap.ensureInitialized()
            Allowlist.loadFromDefaultLocation()
            try await run()
        } catch {
            fputs("error: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }

    private static func run() async throws {
        var args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else {
            printUsage()
            return
        }
        args.removeFirst()

        switch command {
        case "doctor":
            try runDoctor(args: args)
        case "list-apps":
            try runListApps(args: args)
        case "list-windows":
            try await runListWindows(args: args)
        case "click":
            try runClick(args: args)
        case "scroll":
            try runScroll(args: args)
        case "capture-window":
            try await runCaptureWindow(args: args)
        case "type-text":
            try runTypeText(args: args)
        case "find-ui-element":
            try runFindUIElement(args: args)
        case "press-element":
            try runPressElement(args: args)
        case "set-value":
            try runSetValue(args: args)
        case "help", "--help", "-h":
            printUsage()
        default:
            throw CLIError.invalidUsage("Unknown command '\(command)'. Run `claudex-computer-use-cli help`.")
        }
    }

    private static func runDoctor(args: [String]) throws {
        var args = args
        let shouldPrompt = takeFlag("--prompt", from: &args)
        let renderJSON = takeFlag("--json", from: &args)

        guard args.isEmpty else {
            throw CLIError.invalidUsage("Usage: claudex-computer-use-cli doctor [--prompt] [--json]")
        }

        let report = Diagnostics.doctor(
            promptForAccessibility: shouldPrompt,
            promptForScreenRecording: shouldPrompt
        )

        if renderJSON {
            try printJSON(report)
            return
        }

        print("Claudex Computer Use \(report.version)")
        print("macOS: \(report.macOSVersion)")
        print("Accessibility: \(renderStatus(report.permissions.accessibilityTrusted))")
        print("Screen Recording: \(renderStatus(report.permissions.screenRecordingTrusted))")
        print("Running apps seen: \(report.runningAppCount)")
        print("Allowlist: \(report.allowlistMode) (allowed: \(report.allowedBundleIDCount), denied: \(report.deniedBundleIDCount))")
        print(
            "Desktop session: " +
            (report.desktopSession.active
                ? "\(report.desktopSession.mode?.rawValue ?? "active") (actions: \(report.desktopSession.actionsUsed)\(report.desktopSession.actionBudget.map { "/\($0)" } ?? ""))"
                : (report.desktopSession.externalExclusiveLock ? "externally locked" : "idle"))
        )
        print(
            "Virtual cursor: \(report.virtualCursor.config.mode.rawValue)/\(report.virtualCursor.config.style.rawValue) " +
            "(showTrail: \(report.virtualCursor.config.showTrail ? "on" : "off"), trail: \(report.virtualCursor.config.trailLimit), age: \(Int(report.virtualCursor.config.maxAgeSeconds))s, desktop: \(report.virtualCursor.desktopOverlayDriver)/\(report.virtualCursor.desktopOverlayVisible ? "visible" : (report.virtualCursor.desktopOverlayReady ? "ready" : "idle")), legacyHelper: \(report.virtualCursor.overlayHelperRunning ? "running" : "idle"))"
        )
    }

    private static func runListApps(args: [String]) throws {
        var args = args
        let includeBackground = takeFlag("--all", from: &args)
        let renderJSON = takeFlag("--json", from: &args)

        guard args.isEmpty else {
            throw CLIError.invalidUsage("Usage: claudex-computer-use-cli list-apps [--all] [--json]")
        }

        let apps = AppDiscovery.listRunningApps(includeBackground: includeBackground)
        if renderJSON {
            try printJSON(apps)
            return
        }

        for app in apps {
            let name = app.localizedName ?? "(unnamed)"
            let bundleID = app.bundleIdentifier ?? "-"
            let active = app.isActive ? " active" : ""
            print("\(app.pid)\t\(name)\t\(bundleID)\t[\(app.activationPolicy)\(active)]")
        }
    }

    private static func runListWindows(args: [String]) async throws {
        var args = args
        let renderJSON = takeFlag("--json", from: &args)
        let prompt = takeFlag("--prompt", from: &args)
        let pid = try takeInt32Flag("--pid", from: &args)

        guard args.isEmpty else {
            throw CLIError.invalidUsage("Usage: claudex-computer-use-cli list-windows [--pid <pid>] [--prompt] [--json]")
        }

        if prompt {
            _ = PermissionManager.screenRecordingTrusted(prompt: true)
        }

        let windows = try WindowCapture.listWindows(pid: pid)
        if renderJSON {
            try printJSON(windows)
            return
        }

        for window in windows {
            let title = window.title ?? "(untitled)"
            let app = window.appName ?? "(unknown)"
            let flags = [
                window.isActive ? "active" : nil,
                window.isOnScreen ? "onscreen" : nil
            ]
                .compactMap { $0 }
                .joined(separator: ",")

            print(
                "\(window.windowID)\tPID=\(window.pid)\t\(app)\t\(title)\t" +
                "frame=(\(Int(window.frame.x)),\(Int(window.frame.y)) \(Int(window.frame.width))x\(Int(window.frame.height)))" +
                (flags.isEmpty ? "" : "\t[\(flags)]")
            )
        }
    }

    private static func runClick(args: [String]) throws {
        var args = args
        let renderJSON = takeFlag("--json", from: &args)

        guard args.count == 3 else {
            throw CLIError.invalidUsage("Usage: claudex-computer-use-cli click <pid> <x> <y> [--json]")
        }

        guard
            let pid = Int32(args[0]),
            let x = Double(args[1]),
            let y = Double(args[2])
        else {
            throw CLIError.invalidUsage("click expects numeric <pid> <x> <y>.")
        }

        let result = try InputInjector.click(pid: pid, at: ScreenPoint(x: x, y: y))
        if renderJSON {
            try printJSON(result)
            return
        }

        print("🎯 目标：\(result.appName ?? "unknown") (PID=\(result.pid))")
        print("🖱  操作前真实光标位置：(\(result.cursorBefore.x), \(result.cursorBefore.y))")
        print("✅ 已向 PID=\(result.pid) 的进程 (\(result.point.x), \(result.point.y)) 注入点击")
        print("🖱  操作后真实光标位置：(\(result.cursorAfter.x), \(result.cursorAfter.y))")
        if result.cursorMoved {
            print("⚠️  真实光标被移动了")
        } else {
            print("🎉 真实光标未移动")
        }
    }

    private static func runScroll(args: [String]) throws {
        var args = args
        let renderJSON = takeFlag("--json", from: &args)
        let amount = try takeIntFlag("--amount", from: &args) ?? 3
        let x = try takeDoubleFlag("--x", from: &args)
        let y = try takeDoubleFlag("--y", from: &args)

        guard
            args.count == 2,
            let pid = Int32(args[0]),
            let direction = ScrollDirection(rawValue: args[1].lowercased())
        else {
            throw CLIError.invalidUsage(
                "Usage: claudex-computer-use-cli scroll <pid> <up|down|left|right> [--amount <count>] [--x <value> --y <value>] [--json]"
            )
        }

        if (x == nil) != (y == nil) {
            throw CLIError.invalidUsage("scroll expects --x and --y together.")
        }

        let result = try InputInjector.scroll(
            pid: pid,
            direction: direction,
            amount: amount,
            at: makeOptionalPoint(x: x, y: y)
        )

        if renderJSON {
            try printJSON(result)
            return
        }

        print(
            "🛞 已向 \(result.appName ?? "unknown") (PID=\(result.pid)) 注入滚动: " +
            "\(result.direction.rawValue) x\(result.amount)"
        )
    }

    private static func runTypeText(args: [String]) throws {
        var args = args
        let renderJSON = takeFlag("--json", from: &args)
        let restoreFocus = takeFlag("--restore-focus", from: &args)
        let strategyRaw = takeStringFlag("--strategy", from: &args)
        let deliveryRaw = takeStringFlag("--delivery", from: &args)

        guard args.count >= 2 else {
            throw CLIError.invalidUsage("Usage: claudex-computer-use-cli type-text <pid> <text> [--strategy auto|unicodeEvent|pasteboard] [--delivery background|direct] [--restore-focus] [--json]")
        }

        guard let pid = Int32(args.removeFirst()) else {
            throw CLIError.invalidUsage("type-text expects a numeric <pid>.")
        }

        let text = args.joined(separator: " ")
        let strategy = try parseTextInjectionStrategy(strategyRaw)
        let delivery = try parseInteractionDeliveryMode(deliveryRaw)
        let result = try InputInjector.typeText(
            pid: pid,
            text: text,
            strategy: strategy ?? .auto,
            deliveryMode: delivery ?? .background,
            restoreFocus: restoreFocus
        )

        if renderJSON {
            try printJSON(result)
            return
        }

        print("⌨️  目标：\(result.appName ?? "unknown") (PID=\(result.pid))")
        print("✅ 已注入 \(result.charactersSent) 个字符，策略：\(result.strategy.rawValue)，投递：\(result.deliveryMode.rawValue)")
        print("文本：\(result.text)")
    }

    private static func runFindUIElement(args: [String]) throws {
        var args = args
        let renderJSON = takeFlag("--json", from: &args)
        let searchAllWindows = !takeFlag("--focused-window", from: &args)
        let role = takeStringFlag("--role", from: &args)
        let text = takeStringFlag("--text", from: &args)
        let title = takeStringFlag("--title", from: &args)
        let value = takeStringFlag("--value", from: &args)
        let elementDescription = takeStringFlag("--description", from: &args)
        let limit = try takeIntFlag("--limit", from: &args) ?? 10

        guard args.count == 1, let pid = Int32(args[0]) else {
            throw CLIError.invalidUsage(
                "Usage: claudex-computer-use-cli find-ui-element <pid> [--role <role>] [--text <text>] [--title <text>] [--value <text>] [--description <text>] [--limit <count>] [--focused-window] [--json]"
            )
        }

        let result = try UIElementService.findUIElements(
            pid: pid,
            role: role,
            text: text,
            title: title,
            value: value,
            elementDescription: elementDescription,
            maxResults: limit,
            searchAllWindows: searchAllWindows
        )

        if renderJSON {
            try printJSON(result)
            return
        }

        print(
            "🔎 \(result.appName ?? "unknown") (PID=\(result.pid)) " +
            "扫描了 \(result.scannedElementCount) 个元素，在 \(result.searchedWindowCount) 个窗口中命中 \(result.matches.count) 个结果"
        )
        for match in result.matches {
            let title = match.title ?? "(untitled)"
            let role = match.role ?? "(unknown role)"
            let path = renderPath(match.path)
            let actions = match.actions.isEmpty ? "-" : match.actions.joined(separator: ",")
            print(
                "window=\(match.windowIndex)\tpath=\(path)\trole=\(role)\ttitle=\(title)\tactions=\(actions)"
            )
        }
    }

    private static func runPressElement(args: [String]) throws {
        var args = args
        let renderJSON = takeFlag("--json", from: &args)
        let action = takeStringFlag("--action", from: &args)
        let path = try takeIntArrayFlag("--path", from: &args) ?? []
        let windowIndex = try takeIntFlag("--window-index", from: &args)

        guard
            args.count == 1,
            let pid = Int32(args[0]),
            let windowIndex
        else {
            throw CLIError.invalidUsage(
                "Usage: claudex-computer-use-cli press-element <pid> --window-index <index> [--path <child,child,...>] [--action <action>] [--json]"
            )
        }

        let result = try UIElementService.pressElement(
            pid: pid,
            windowIndex: windowIndex,
            path: path,
            action: action
        )

        if renderJSON {
            try printJSON(result)
            return
        }

        print(
            "✅ 已执行 \(result.action) on \(result.role ?? "(unknown role)") " +
            "\"\(result.title ?? "(untitled)")\" at window=\(result.windowIndex) path=\(renderPath(result.path))"
        )
    }

    private static func runSetValue(args: [String]) throws {
        var args = args
        let renderJSON = takeFlag("--json", from: &args)
        let path = try takeIntArrayFlag("--path", from: &args) ?? []
        let windowIndex = try takeIntFlag("--window-index", from: &args)
        let valueType = takeStringFlag("--type", from: &args) ?? "string"

        guard
            args.count >= 2,
            let pid = Int32(args.removeFirst()),
            let windowIndex
        else {
            throw CLIError.invalidUsage(
                "Usage: claudex-computer-use-cli set-value <pid> --window-index <index> [--path <child,child,...>] [--type <string|number|bool>] <value> [--json]"
            )
        }

        let rawValue = args.joined(separator: " ")
        let value = try parseUIElementValue(rawValue, valueType: valueType)
        let result = try UIElementService.setValue(
            pid: pid,
            windowIndex: windowIndex,
            path: path,
            value: value
        )

        if renderJSON {
            try printJSON(result)
            return
        }

        print(
            "✅ 已设置 \(result.role ?? "(unknown role)") " +
            "\"\(result.title ?? "(untitled)")\" 的 AXValue 为 \(result.requestedValue)"
        )
    }

    private static func runCaptureWindow(args: [String]) async throws {
        var args = args
        let renderJSON = takeFlag("--json", from: &args)
        let prompt = takeFlag("--prompt", from: &args)
        let windowID = try takeUInt32Flag("--window-id", from: &args)
        let scale = try takeDoubleFlag("--scale", from: &args) ?? 1.0
        let output = takeStringFlag("--output", from: &args)

        guard args.count == 1, let pid = Int32(args[0]) else {
            throw CLIError.invalidUsage(
                "Usage: claudex-computer-use-cli capture-window <pid> [--window-id <id>] [--scale <value>] [--output <path>] [--prompt] [--json]"
            )
        }

        let capture = try WindowCapture.captureWindow(
            pid: pid,
            windowID: windowID,
            scale: scale,
            promptForScreenRecording: prompt
        )

        if renderJSON {
            let payload: [String: AnyEncodable] = [
                "metadata": AnyEncodable(capture.metadata),
                "pngBase64": AnyEncodable(capture.pngData.base64EncodedString())
            ]
            try printJSON(payload)
            return
        }

        let destination: URL
        if let output {
            destination = URL(fileURLWithPath: output)
        } else {
            let fileName = "claudex-computer-use-\(capture.metadata.window.windowID).png"
            destination = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(fileName)
        }

        try capture.writePNG(to: destination)
        print("🪟  窗口：\(capture.metadata.window.title ?? "(untitled)")")
        print("📦  像素：\(capture.metadata.pixelWidth)x\(capture.metadata.pixelHeight)")
        print("💾  已写入：\(destination.path)")
    }

    private static func takeFlag(_ flag: String, from args: inout [String]) -> Bool {
        guard let index = args.firstIndex(of: flag) else {
            return false
        }

        args.remove(at: index)
        return true
    }

    private static func takeStringFlag(_ flag: String, from args: inout [String]) -> String? {
        guard let index = args.firstIndex(of: flag) else {
            return nil
        }

        let valueIndex = args.index(after: index)
        guard valueIndex < args.endIndex else {
            return nil
        }

        let value = args[valueIndex]
        args.remove(at: valueIndex)
        args.remove(at: index)
        return value
    }

    private static func takeInt32Flag(_ flag: String, from args: inout [String]) throws -> Int32? {
        guard let raw = takeStringFlag(flag, from: &args) else {
            return nil
        }

        guard let value = Int32(raw) else {
            throw CLIError.invalidUsage("Flag \(flag) expects an Int32 value.")
        }

        return value
    }

    private static func takeUInt32Flag(_ flag: String, from args: inout [String]) throws -> UInt32? {
        guard let raw = takeStringFlag(flag, from: &args) else {
            return nil
        }

        guard let value = UInt32(raw) else {
            throw CLIError.invalidUsage("Flag \(flag) expects a UInt32 value.")
        }

        return value
    }

    private static func takeDoubleFlag(_ flag: String, from args: inout [String]) throws -> Double? {
        guard let raw = takeStringFlag(flag, from: &args) else {
            return nil
        }

        guard let value = Double(raw) else {
            throw CLIError.invalidUsage("Flag \(flag) expects a numeric value.")
        }

        return value
    }

    private static func takeIntFlag(_ flag: String, from args: inout [String]) throws -> Int? {
        guard let raw = takeStringFlag(flag, from: &args) else {
            return nil
        }

        guard let value = Int(raw) else {
            throw CLIError.invalidUsage("Flag \(flag) expects an integer value.")
        }

        return value
    }

    private static func takeIntArrayFlag(_ flag: String, from args: inout [String]) throws -> [Int]? {
        guard let raw = takeStringFlag(flag, from: &args) else {
            return nil
        }

        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return []
        }

        return try trimmed.split(separator: ",").map { part in
            let value = part.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let parsed = Int(value) else {
                throw CLIError.invalidUsage("Flag \(flag) expects a comma-separated integer path.")
            }
            return parsed
        }
    }

    private static func renderStatus(_ value: Bool) -> String {
        value ? "granted" : "missing"
    }

    private static func renderPath(_ path: [Int]) -> String {
        path.isEmpty ? "(root)" : path.map(String.init).joined(separator: ",")
    }

    private static func parseUIElementValue(_ rawValue: String, valueType: String) throws -> UIElementValueInput {
        switch valueType.lowercased() {
        case "string":
            return .string(rawValue)
        case "number":
            guard let value = Double(rawValue) else {
                throw CLIError.invalidUsage("set-value --type number expects a numeric value.")
            }
            return .number(value)
        case "bool", "boolean":
            switch rawValue.lowercased() {
            case "true", "1", "yes":
                return .bool(true)
            case "false", "0", "no":
                return .bool(false)
            default:
                throw CLIError.invalidUsage("set-value --type bool expects true/false.")
            }
        default:
            throw CLIError.invalidUsage("set-value --type must be one of string, number, or bool.")
        }
    }

    private static func parseInteractionDeliveryMode(_ rawValue: String?) throws -> InteractionDeliveryMode? {
        guard let rawValue else {
            return nil
        }
        guard let mode = InteractionDeliveryMode(rawValue: rawValue) else {
            throw CLIError.invalidUsage("--delivery must be background or direct.")
        }
        return mode
    }

    private static func parseTextInjectionStrategy(_ rawValue: String?) throws -> TextInjectionStrategy? {
        guard let rawValue else {
            return nil
        }
        guard let strategy = TextInjectionStrategy(rawValue: rawValue) else {
            throw CLIError.invalidUsage("--strategy must be auto, unicodeEvent, or pasteboard.")
        }
        return strategy
    }

    private static func makeOptionalPoint(x: Double?, y: Double?) -> ScreenPoint? {
        guard let x, let y else {
            return nil
        }

        return ScreenPoint(x: x, y: y)
    }

    private static func printUsage() {
        print(
            """
            Claudex Computer Use CLI

            Commands:
              doctor [--prompt] [--json]
              list-apps [--all] [--json]
              list-windows [--pid <pid>] [--prompt] [--json]
              click <pid> <x> <y> [--json]
              scroll <pid> <up|down|left|right> [--amount <count>] [--x <value> --y <value>] [--json]
              capture-window <pid> [--window-id <id>] [--scale <value>] [--output <path>] [--prompt] [--json]
              type-text <pid> <text> [--strategy auto|unicodeEvent|pasteboard] [--delivery background|direct] [--restore-focus] [--json]
              find-ui-element <pid> [--role <role>] [--text <text>] [--title <text>] [--value <text>] [--description <text>] [--limit <count>] [--focused-window] [--json]
              press-element <pid> --window-index <index> [--path <child,child,...>] [--action <action>] [--json]
              set-value <pid> --window-index <index> [--path <child,child,...>] [--type <string|number|bool>] <value> [--json]
            """
        )
    }

    private static func printJSON<T: Encodable>(_ value: T) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(value)
        guard let output = String(data: data, encoding: .utf8) else {
            throw CLIError.invalidUsage("Failed to render JSON output.")
        }
        print(output)
    }
}

private struct AnyEncodable: Encodable {
    private let encoder: (Encoder) throws -> Void

    init<T: Encodable>(_ value: T) {
        encoder = value.encode
    }

    func encode(to encoder: Encoder) throws {
        try self.encoder(encoder)
    }
}

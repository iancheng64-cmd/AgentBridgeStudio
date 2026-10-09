import AppKit
import Foundation
import ClaudexComputerUseCore

@main
struct ClaudexComputerUseOverlayHelper {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        let delegate = OverlayHelperAppDelegate()
        app.delegate = delegate
        app.run()
    }
}

private final class OverlayHelperAppDelegate: NSObject, NSApplicationDelegate {
    private var coordinator: OverlayCoordinator?

    func applicationDidFinishLaunching(_ notification: Notification) {
        OverlayHelperController.writeCurrentPIDFile()
        coordinator = OverlayCoordinator()
        coordinator?.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        OverlayHelperController.clearCurrentPIDFile()
    }
}

private final class OverlayCoordinator {
    private var timer: Timer?
    private var windows: [String: OverlayWindowController] = [:]
    private let decoder = JSONDecoder()
    private var lastStateUpdate = Date()
    private let idleExitInterval: TimeInterval = 12

    func start() {
        sync()
        timer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            self?.sync()
        }
    }

    private func sync() {
        let now = Date()
        let state = loadState()
        if let state {
            lastStateUpdate = state.updatedAt
        }

        let config = state?.config ?? VirtualCursorConfig(
            mode: .off,
            style: .secondCursor,
            showTrail: false,
            trailLimit: 8,
            maxAgeSeconds: 45
        )
        let marks = flattenMarks(from: state, now: now)

        ensureWindows()

        let shouldShow = config.mode.rendersOnDesktop
        for controller in windows.values {
            controller.update(
                config: config,
                marks: marks,
                visible: shouldShow
            )
        }

        if !shouldShow && now.timeIntervalSince(lastStateUpdate) > idleExitInterval {
            NSApp.terminate(nil)
        }
    }

    private func ensureWindows() {
        let currentKeys = Set(NSScreen.screens.map(screenKey))
        let existingKeys = Set(windows.keys)

        for staleKey in existingKeys.subtracting(currentKeys) {
            windows[staleKey]?.close()
            windows.removeValue(forKey: staleKey)
        }

        for screen in NSScreen.screens {
            let key = screenKey(screen)
            if windows[key] == nil {
                windows[key] = OverlayWindowController(screen: screen)
            }
        }
    }

    private func flattenMarks(
        from state: VirtualCursorOverlayState?,
        now: Date
    ) -> [VirtualCursorMark] {
        guard let state else {
            return []
        }
        let oldest = now.addingTimeInterval(-state.config.maxAgeSeconds)
        return state.marksByPID.values
            .flatMap { $0 }
            .filter { $0.timestamp >= oldest }
            .sorted { $0.timestamp < $1.timestamp }
    }

    private func loadState() -> VirtualCursorOverlayState? {
        let url = VirtualCursor.overlayStateURL()
        guard let data = try? Data(contentsOf: url) else {
            return nil
        }
        return try? decoder.decode(VirtualCursorOverlayState.self, from: data)
    }

    private func screenKey(_ screen: NSScreen) -> String {
        let frame = screen.frame
        return "\(frame.origin.x):\(frame.origin.y):\(frame.size.width):\(frame.size.height)"
    }
}

private final class OverlayWindowController {
    private let window: NSWindow
    private let view: OverlayCanvasView

    init(screen: NSScreen) {
        let frame = screen.frame
        self.view = OverlayCanvasView(frame: NSRect(origin: .zero, size: frame.size))
        self.window = NSWindow(
            contentRect: frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false,
            screen: screen
        )

        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .statusBar
        window.collectionBehavior = [
            .canJoinAllSpaces,
            .stationary,
            .ignoresCycle,
            .fullScreenAuxiliary
        ]
        window.contentView = view
    }

    func update(
        config: VirtualCursorConfig,
        marks: [VirtualCursorMark],
        visible: Bool
    ) {
        view.config = config
        view.marks = marks
        if visible {
            window.orderFrontRegardless()
        } else {
            window.orderOut(nil)
        }
    }

    func close() {
        window.close()
    }
}

private final class OverlayCanvasView: NSView {
    private struct LocalMark {
        let point: CGPoint
        let kind: String
        let accuracy: VirtualCursorAccuracy
        let timestamp: Date

        var drawMark: VirtualCursorDrawMark {
            VirtualCursorDrawMark(
                point: point,
                kind: kind,
                accuracy: accuracy,
                timestamp: timestamp
            )
        }

        var signature: String {
            "\(timestamp.timeIntervalSince1970)-\(kind)-\(Int(point.x.rounded()))-\(Int(point.y.rounded()))"
        }
    }

    var config = VirtualCursorConfig(
        mode: .off,
        style: .secondCursor,
        showTrail: false,
        trailLimit: 8,
        maxAgeSeconds: 45
    ) {
        didSet { needsDisplay = true }
    }
    var marks: [VirtualCursorMark] = [] {
        didSet { needsDisplay = true }
    }

    private var lastAnimationSignature: String?
    private var animationFromPoint: CGPoint?
    private var animationToPoint: CGPoint?
    private var animationStartTime = Date.distantPast
    private var animationDuration: TimeInterval = 0
    private var animationTilt: CGFloat = 0

    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard config.mode.rendersOnDesktop else {
            return
        }

        guard let context = NSGraphicsContext.current?.cgContext else {
            return
        }

        context.clear(bounds)
        let localMarks = localizedMarks()
        guard !localMarks.isEmpty else {
            return
        }

        let now = Date()
        syncAnimationState(with: localMarks, now: now)

        VirtualCursorRenderer.draw(
            in: context,
            config: config,
            marks: localMarks.map(\.drawMark),
            currentPoint: animatedCursorPoint(now: now),
            currentTilt: animatedTilt(now: now),
            now: now
        )
    }

    private func localizedMarks() -> [LocalMark] {
        let frame = window?.screen?.frame ?? .zero
        return marks.compactMap { mark in
            let x = mark.point.x - frame.origin.x
            let y = mark.point.y - frame.origin.y
            guard x >= -48, y >= -48, x <= frame.size.width + 48, y <= frame.size.height + 48 else {
                return nil
            }
            return LocalMark(
                point: CGPoint(x: x, y: y),
                kind: mark.kind,
                accuracy: mark.accuracy,
                timestamp: mark.timestamp
            )
        }
    }

    private func syncAnimationState(with marks: [LocalMark], now: Date) {
        guard let latest = marks.last else {
            return
        }
        let signature = latest.signature
        guard signature != lastAnimationSignature else {
            return
        }

        let start = animatedCursorPoint(now: now)
            ?? animationToPoint
            ?? marks.dropLast().last?.point
            ?? latest.point
        animationFromPoint = start
        animationToPoint = latest.point
        animationStartTime = now
        animationDuration = transitionDuration(from: start, to: latest.point)
        animationTilt = cursorTilt(from: start, to: latest.point)
        lastAnimationSignature = signature
    }

    private func animatedCursorPoint(now: Date) -> CGPoint? {
        guard let from = animationFromPoint, let to = animationToPoint else {
            return nil
        }
        guard animationDuration > 0 else {
            return to
        }

        let elapsed = now.timeIntervalSince(animationStartTime)
        let progress = max(0, min(1, elapsed / animationDuration))
        if progress >= 1 {
            return to
        }

        let eased = easeInOut(progress)
        let dx = to.x - from.x
        let dy = to.y - from.y
        let distance = hypot(dx, dy)
        let base = CGPoint(
            x: from.x + (dx * eased),
            y: from.y + (dy * eased)
        )
        guard distance > 1 else {
            return base
        }

        let lift = min(
            config.style == .ghostArrow ? 24 : 16,
            max(0, distance * (config.style == .ghostArrow ? 0.10 : 0.06))
        )
        let normalX = -dy / distance
        let normalY = dx / distance
        let directionBias: CGFloat = dx >= 0 ? 1 : -1
        let curve = sin(CGFloat(progress) * .pi) * lift * directionBias
        return CGPoint(
            x: base.x + (normalX * curve),
            y: base.y + (normalY * curve)
        )
    }

    private func animatedTilt(now: Date) -> CGFloat {
        guard animationDuration > 0 else {
            return 0
        }
        let elapsed = now.timeIntervalSince(animationStartTime)
        let progress = max(0, min(1, elapsed / animationDuration))
        return animationTilt * (1 - CGFloat(progress))
    }

    private func transitionDuration(from: CGPoint, to: CGPoint) -> TimeInterval {
        let distance = hypot(to.x - from.x, to.y - from.y)
        switch config.style {
        case .crosshair:
            return min(0.18, max(0.08, 0.10 + (distance / 1800)))
        case .secondCursor:
            return min(0.26, max(0.12, 0.14 + (distance / 1400)))
        case .ghostArrow:
            return min(0.32, max(0.14, 0.18 + (distance / 1200)))
        }
    }

    private func cursorTilt(from: CGPoint, to: CGPoint) -> CGFloat {
        let dx = to.x - from.x
        let dy = to.y - from.y
        let magnitude = max(abs(dx) + abs(dy), 1)
        let horizontalBias = dx / magnitude
        return horizontalBias * (config.style == .ghostArrow ? 0.20 : 0.14)
    }

    private func easeInOut(_ progress: Double) -> CGFloat {
        let p = CGFloat(progress)
        if p < 0.5 {
            return 2 * p * p
        }
        return 1 - pow(-2 * p + 2, 2) / 2
    }
}

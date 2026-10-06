import AppKit
import Foundation

public struct DesktopOverlayRuntimeStatus: Codable {
    public let driver: String
    public let ready: Bool
    public let visible: Bool

    public init(driver: String, ready: Bool, visible: Bool) {
        self.driver = driver
        self.ready = ready
        self.visible = visible
    }
}

/// Same-process live desktop cursor overlay. Modeled after mac-computer-use's OverlayCursorController.
/// All public methods dispatch to main thread internally — safe to call from any thread.
public final class OverlayCursorController {
    public static let shared = OverlayCursorController()

    private struct WindowDescriptor {
        let id: CGWindowID
        let frame: CGRect
    }

    private struct WindowRelativeAnchor {
        let pid: Int32
        let windowID: CGWindowID?
        let normalizedX: CGFloat
        let normalizedY: CGFloat
    }

    private let windowSize: CGFloat = 96
    /// Cursor-tip location inside the flipped NSView (origin at top-left).
    /// secondCursorPath tip is at (0,0); in the view we draw at this offset.
    private let viewHotspot = CGPoint(x: 28, y: 14)
    private let idleHideDelay: TimeInterval = 12.0
    private let idleTickInterval: TimeInterval = 1.0 / 30.0

    private var window: NSWindow?
    private var cursorView: LiveCursorView?
    private var currentDisplayPoint: CGPoint? // AX / display coordinates (origin top-left)
    private var idleAnchorPoint: CGPoint?
    private var currentTargetPID: Int32?
    private var windowRelativeAnchor: WindowRelativeAnchor?
    private var hideWorkItem: DispatchWorkItem?
    private var idleTimer: Timer?
    private var idlePhase: CGFloat = 0

    private init() {}

    // MARK: - Public API

    /// Animate the live cursor to a target point, then return (blocking).
    /// Call this BEFORE executing the real click/drag/scroll.
    public func animate(
        to displayPoint: CGPoint,
        accuracy: VirtualCursorAccuracy = .coordinate,
        style: VirtualCursorStyle = .ghostArrow,
        kind: String = "click",
        targetPID: Int32? = nil
    ) {
        guard VirtualCursor.currentConfig().mode.rendersOnDesktop else { return }
        dispatchMainSync {
            self.animateImpl(
                to: displayPoint,
                accuracy: accuracy,
                style: style,
                kind: kind,
                targetPID: targetPID
            )
        }
    }

    /// Click-landing pulse animation (shrink + bounce).
    public func pulse() {
        guard VirtualCursor.currentConfig().mode.rendersOnDesktop else { return }
        dispatchMainSync { self.pulseImpl() }
    }

    /// Start a desktop-session-owned cursor lifecycle. The cursor parks inside
    /// the target app window and then stays visible until the desktop session ends.
    public func beginDesktopSession(targetPID: Int32?) {
        guard VirtualCursor.currentConfig().mode.rendersOnDesktop else { return }
        dispatchMainSync {
            let config = VirtualCursor.currentConfig()
            let target = self.sessionAnchorPoint(for: targetPID) ?? self.currentDisplayPoint ?? self.currentMouseDisplayPoint()
            self.animateImpl(
                to: target,
                accuracy: .semantic,
                style: config.style,
                kind: "session.start",
                targetPID: targetPID
            )
        }
    }

    /// End a desktop-session-owned cursor lifecycle immediately.
    public func endDesktopSession() {
        hide()
    }

    /// Fade out and hide the cursor.
    public func hide() {
        dispatchMainSync { self.hideImpl() }
    }

    public func runtimeStatus() -> DesktopOverlayRuntimeStatus {
        var status = DesktopOverlayRuntimeStatus(driver: "same-process", ready: false, visible: false)
        dispatchMainSync {
            status = DesktopOverlayRuntimeStatus(
                driver: "same-process",
                ready: self.window != nil,
                visible: (self.window?.isVisible ?? false) && (self.window?.alphaValue ?? 0) > 0.01
            )
        }
        return status
    }

    // MARK: - Animate implementation (main thread only)

    private func animateImpl(
        to target: CGPoint,
        accuracy: VirtualCursorAccuracy,
        style: VirtualCursorStyle,
        kind: String,
        targetPID: Int32?
    ) {
        cancelHide()
        stopIdleAnimation()
        let start = animationStartPoint(for: target)
        let _ = ensureWindow(style: style, accuracy: accuracy, kind: kind)

        let dx = target.x - start.x
        let dy = target.y - start.y
        let distance = hypot(dx, dy)
        let duration = animationDuration(distance: distance, style: style)
        let steps = max(Int(duration / 0.016), 1) // ~60fps
        let tilt = cursorTilt(dx: dx, dy: dy, style: style)

        for step in 1...steps {
            let progress = CGFloat(step) / CGFloat(steps)
            let eased = easeInOut(Double(progress))
            let x = start.x + dx * eased
            let y = start.y + dy * eased
            let current = CGPoint(x: x, y: y)

            cursorView?.cursorTilt = tilt * (1 - eased)
            moveTo(displayPoint: current, targetPID: targetPID)
            RunLoop.current.run(until: Date().addingTimeInterval(duration / Double(steps)))
        }

        cursorView?.cursorTilt = 0
        currentDisplayPoint = target
        idleAnchorPoint = target
        currentTargetPID = targetPID
        windowRelativeAnchor = makeWindowRelativeAnchor(point: target, pid: targetPID)
        startIdleAnimation()
        scheduleIdleHide()
    }

    private func pulseImpl() {
        guard let view = cursorView else { return }
        cancelHide()
        stopIdleAnimation()
        view.pressed = true
        view.needsDisplay = true

        let steps = 6
        for step in 1...steps {
            let progress = CGFloat(step) / CGFloat(steps)
            view.pulseProgress = progress
            view.needsDisplay = true
            RunLoop.current.run(until: Date().addingTimeInterval(0.026))
        }

        view.pressed = false
        view.pulseProgress = 0
        view.needsDisplay = true
        startIdleAnimation()
        scheduleIdleHide()
    }

    // MARK: - Window management

    private func ensureWindow(
        style: VirtualCursorStyle,
        accuracy: VirtualCursorAccuracy,
        kind: String
    ) -> NSWindow {
        if let window, let view = cursorView {
            view.style = style
            view.accuracy = accuracy
            view.kind = kind
            return window
        }

        let view = LiveCursorView(
            frame: NSRect(origin: .zero, size: NSSize(width: windowSize, height: windowSize))
        )
        view.style = style
        view.accuracy = accuracy
        view.kind = kind

        let frame = NSRect(x: -1000, y: -1000, width: windowSize, height: windowSize)
        let win = NSWindow(
            contentRect: frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = false
        win.ignoresMouseEvents = true
        win.level = .normal
        win.collectionBehavior = [.stationary, .transient, .ignoresCycle]
        win.contentView = view

        self.window = win
        self.cursorView = view
        return win
    }

    private func moveTo(displayPoint: CGPoint, targetPID: Int32?) {
        guard let window else { return }
        guard shouldDisplayOverlay(for: targetPID) else {
            if window.isVisible || window.alphaValue > 0.01 {
                window.alphaValue = 0
                window.orderOut(nil)
            }
            return
        }

        let appKit = appKitPoint(from: displayPoint)
        let windowHotspot = windowHotspotPoint()
        window.setFrameOrigin(NSPoint(
            x: appKit.x - windowHotspot.x,
            y: appKit.y - windowHotspot.y
        ))

        // Z-order: float above the target app's window
        if let targetPID, let windowID = frontmostWindowID(for: targetPID, near: displayPoint) {
            window.order(.above, relativeTo: Int(windowID))
        } else {
            window.orderFrontRegardless()
        }

        if window.alphaValue < 0.9 {
            window.alphaValue = 1
        }

        cursorView?.needsDisplay = true
    }

    private func hideImpl() {
        cancelHide()
        stopIdleAnimation()
        guard let window else { return }
        currentDisplayPoint = nil
        idleAnchorPoint = nil
        currentTargetPID = nil
        windowRelativeAnchor = nil
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.3
            window.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            self?.window?.orderOut(nil)
        }
    }

    private func scheduleIdleHide() {
        guard !DesktopSessionManager.status().active else {
            cancelHide()
            return
        }
        cancelHide()
        let item = DispatchWorkItem { [weak self] in
            self?.dispatchMainSync { self?.hideImpl() }
        }
        hideWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + idleHideDelay, execute: item)
    }

    private func cancelHide() {
        hideWorkItem?.cancel()
        hideWorkItem = nil
    }

    private func startIdleAnimation() {
        guard let view = cursorView, let anchor = idleAnchorPoint else { return }

        stopIdleAnimation()
        idlePhase = 0

        let timer = Timer(timeInterval: idleTickInterval, repeats: true) { [weak self] _ in
            guard let self, let view = self.cursorView, let base = self.idleAnchorPoint else { return }

            self.idlePhase += 0.08
            let anchor = self.resolveIdleAnchorPoint() ?? base
            let offset = self.idleOffset(for: self.idlePhase, accuracy: view.accuracy)
            let current = CGPoint(x: anchor.x + offset.x, y: anchor.y + offset.y)
            self.currentDisplayPoint = current
            view.cursorTilt = self.idleTilt(for: self.idlePhase, style: view.style, accuracy: view.accuracy)
            self.moveTo(displayPoint: current, targetPID: self.currentTargetPID)
        }
        idleTimer = timer
        RunLoop.main.add(timer, forMode: .common)

        // Draw the first resting frame immediately so the cursor visibly settles
        // into a "thinking" pose instead of waiting for the first timer tick.
        let anchorPoint = resolveIdleAnchorPoint() ?? anchor
        let offset = idleOffset(for: idlePhase, accuracy: view.accuracy)
        let current = CGPoint(x: anchorPoint.x + offset.x, y: anchorPoint.y + offset.y)
        currentDisplayPoint = current
        view.cursorTilt = idleTilt(for: idlePhase, style: view.style, accuracy: view.accuracy)
        moveTo(displayPoint: current, targetPID: currentTargetPID)
    }

    private func stopIdleAnimation() {
        idleTimer?.invalidate()
        idleTimer = nil
        idlePhase = 0
        cursorView?.cursorTilt = 0
    }

    // MARK: - Coordinate transforms

    /// Convert global display coordinates (Quartz / AX, origin at the top-left of the primary display)
    /// into AppKit screen coordinates (origin at the bottom-left of the primary display).
    ///
    /// This must use the primary display's height as the shared baseline. Using the union of all
    /// screens is wrong for stacked multi-monitor layouts because it injects an extra offset equal
    /// to the height of the screens above/below the primary display.
    private func appKitPoint(from displayPoint: CGPoint) -> CGPoint {
        let primaryHeight = primaryDisplayFrame().height
        return CGPoint(x: displayPoint.x, y: primaryHeight - displayPoint.y)
    }

    /// Bounds of the primary display in Quartz display coordinates.
    private func primaryDisplayFrame() -> CGRect {
        let frame = CGDisplayBounds(CGMainDisplayID())
        guard !frame.isNull, !frame.isEmpty else {
            return CGRect(x: 0, y: 0, width: 1, height: 1)
        }
        return frame
    }

    private func displayPoint(from appKitPoint: CGPoint) -> CGPoint {
        let primaryHeight = primaryDisplayFrame().height
        return CGPoint(x: appKitPoint.x, y: primaryHeight - appKitPoint.y)
    }

    private func currentMouseDisplayPoint() -> CGPoint {
        displayPoint(from: NSEvent.mouseLocation)
    }

    private func shouldDisplayOverlay(for targetPID: Int32?) -> Bool {
        guard let targetPID else {
            return false
        }
        return windowFrame(for: targetPID, windowID: nil) != nil
    }

    /// Translate the flipped-view hotspot into the window's AppKit coordinate space.
    private func windowHotspotPoint() -> CGPoint {
        CGPoint(x: viewHotspot.x, y: windowSize - viewHotspot.y)
    }

    /// Compute the starting position for the animation.
    private func animationStartPoint(for target: CGPoint) -> CGPoint {
        if let current = currentDisplayPoint {
            return current
        }
        // First appearance: ease in from the lower-left so the cursor reads as
        // a guided overlay rather than a hard teleport.
        return CGPoint(x: target.x - 42, y: target.y + 20)
    }

    // MARK: - Z-order tracking

    /// Find on-screen windows for a given PID (layer 0 = normal windows), ordered front-to-back.
    private func windowDescriptors(for pid: Int32) -> [WindowDescriptor] {
        guard let list = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return []
        }

        var descriptors: [WindowDescriptor] = []
        for info in list {
            guard
                let owner = info[kCGWindowOwnerPID as String] as? Int32,
                owner == pid,
                let layer = info[kCGWindowLayer as String] as? Int,
                layer == 0,
                let windowID = info[kCGWindowNumber as String] as? CGWindowID,
                let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                let frame = CGRect(dictionaryRepresentation: boundsDict),
                frame.width > 1,
                frame.height > 1
            else { continue }
            descriptors.append(WindowDescriptor(id: windowID, frame: frame))
        }
        return descriptors
    }

    private func nearestWindowDescriptor(for pid: Int32, near point: CGPoint?) -> WindowDescriptor? {
        let descriptors = windowDescriptors(for: pid)
        guard !descriptors.isEmpty else {
            return nil
        }

        guard let point else {
            return descriptors.first
        }

        if let containing = descriptors.first(where: { $0.frame.contains(point) }) {
            return containing
        }

        return descriptors.min { lhs, rhs in
            let lhsCenter = CGPoint(x: lhs.frame.midX, y: lhs.frame.midY)
            let rhsCenter = CGPoint(x: rhs.frame.midX, y: rhs.frame.midY)
            return hypot(lhsCenter.x - point.x, lhsCenter.y - point.y)
                < hypot(rhsCenter.x - point.x, rhsCenter.y - point.y)
        }
    }

    /// Find the most relevant on-screen window for a given PID.
    private func frontmostWindowID(for pid: Int32, near point: CGPoint?) -> CGWindowID? {
        nearestWindowDescriptor(for: pid, near: point)?.id
    }

    private func windowFrame(for pid: Int32, windowID: CGWindowID?) -> CGRect? {
        let descriptors = windowDescriptors(for: pid)
        if let windowID,
           let exact = descriptors.first(where: { $0.id == windowID }) {
            return exact.frame
        }
        return descriptors.first?.frame
    }

    private func sessionAnchorPoint(for pid: Int32?) -> CGPoint? {
        guard let pid, let frame = windowFrame(for: pid, windowID: nil), frame.width > 1, frame.height > 1 else {
            return nil
        }

        return CGPoint(
            x: frame.minX + (frame.width * 0.52),
            y: frame.minY + (frame.height * 0.28)
        )
    }

    private func makeWindowRelativeAnchor(point: CGPoint, pid: Int32?) -> WindowRelativeAnchor? {
        guard let pid,
              let descriptor = nearestWindowDescriptor(for: pid, near: point),
              descriptor.frame.width > 1,
              descriptor.frame.height > 1 else {
            return nil
        }
        let frame = descriptor.frame
        let normalizedX = min(max((point.x - frame.minX) / frame.width, 0), 1)
        let normalizedY = min(max((point.y - frame.minY) / frame.height, 0), 1)
        return WindowRelativeAnchor(
            pid: pid,
            windowID: descriptor.id,
            normalizedX: normalizedX,
            normalizedY: normalizedY
        )
    }

    private func resolveIdleAnchorPoint() -> CGPoint? {
        guard let relative = windowRelativeAnchor,
              let frame = windowFrame(for: relative.pid, windowID: relative.windowID),
              frame.width > 1,
              frame.height > 1 else {
            return idleAnchorPoint
        }

        let point = CGPoint(
            x: frame.minX + (frame.width * relative.normalizedX),
            y: frame.minY + (frame.height * relative.normalizedY)
        )
        idleAnchorPoint = point
        return point
    }

    // MARK: - Animation math

    private func animationDuration(distance: CGFloat, style: VirtualCursorStyle) -> TimeInterval {
        switch style {
        case .crosshair:
            return min(0.20, max(0.08, 0.10 + Double(distance) / 1800))
        case .secondCursor:
            return min(0.28, max(0.12, 0.14 + Double(distance) / 1400))
        case .ghostArrow:
            return min(0.34, max(0.14, 0.18 + Double(distance) / 1200))
        }
    }

    private func cursorTilt(dx: CGFloat, dy: CGFloat, style: VirtualCursorStyle) -> CGFloat {
        let magnitude = max(abs(dx) + abs(dy), 1)
        let horizontalBias = dx / magnitude
        return horizontalBias * (style == .ghostArrow ? 0.20 : 0.14)
    }

    private func easeInOut(_ t: Double) -> CGFloat {
        let p = CGFloat(t)
        if p < 0.5 { return 2 * p * p }
        return 1 - pow(-2 * p + 2, 2) / 2
    }

    private func idleOffset(for phase: CGFloat, accuracy: VirtualCursorAccuracy) -> CGPoint {
        let driftAmplitude: CGFloat = accuracy.drawsDirectionalPointer ? 0.55 : 0.35
        let gesture = idleGestureAmount(for: phase)
        return CGPoint(
            x: cos(phase * 0.35) * driftAmplitude + gesture * 0.55,
            y: sin(phase * 0.48) * (driftAmplitude * 0.42) - gesture * 0.20
        )
    }

    private func idleTilt(
        for phase: CGFloat,
        style: VirtualCursorStyle,
        accuracy: VirtualCursorAccuracy
    ) -> CGFloat {
        guard accuracy.drawsDirectionalPointer else { return 0 }

        let restTilt: CGFloat
        let gestureTilt: CGFloat
        switch style {
        case .ghostArrow:
            restTilt = 0.05
            gestureTilt = 0.26
        case .secondCursor:
            restTilt = 0.04
            gestureTilt = 0.22
        case .crosshair:
            restTilt = 0
            gestureTilt = 0
        }
        let gesture = idleGestureAmount(for: phase)
        let microWobble = sin(phase * 0.42) * 0.01
        return restTilt + microWobble + (gesture * gestureTilt)
    }

    private func idleGestureAmount(for phase: CGFloat) -> CGFloat {
        let cycle = phase.truncatingRemainder(dividingBy: 5.2)
        switch cycle {
        case 0..<2.9:
            return 0
        case 2.9..<3.45:
            return easeInOut(Double((cycle - 2.9) / 0.55))
        case 3.45..<3.95:
            return 1
        case 3.95..<4.55:
            return 1 - easeInOut(Double((cycle - 3.95) / 0.60))
        default:
            return 0
        }
    }

    // MARK: - Thread dispatch

    private func dispatchMainSync(_ block: () -> Void) {
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.sync { block() }
        }
    }
}

// MARK: - Cursor View

private final class LiveCursorView: NSView {
    var style: VirtualCursorStyle = .ghostArrow { didSet { needsDisplay = true } }
    var accuracy: VirtualCursorAccuracy = .coordinate { didSet { needsDisplay = true } }
    var kind: String = "click" { didSet { needsDisplay = true } }
    var cursorTilt: CGFloat = 0 { didSet { needsDisplay = true } }
    var pressed: Bool = false { didSet { needsDisplay = true } }
    var pulseProgress: CGFloat = 0 { didSet { needsDisplay = true } }

    override var isOpaque: Bool { false }
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.clear(bounds)

        // Draw cursor at the tip position inside the flipped 96x96 view.
        let drawPoint = CGPoint(x: 28, y: 14)
        let mark = VirtualCursorDrawMark(
            point: drawPoint,
            kind: kind,
            accuracy: accuracy,
            timestamp: pressed ? Date() : Date().addingTimeInterval(-0.5) // controls pulse
        )

        let config = VirtualCursorConfig(
            mode: .desktopOverlay,
            style: style,
            showTrail: false,
            trailLimit: 1,
            maxAgeSeconds: 60
        )

        VirtualCursorRenderer.draw(
            in: context,
            config: config,
            marks: [mark],
            currentTilt: cursorTilt,
            now: Date()
        )
    }
}

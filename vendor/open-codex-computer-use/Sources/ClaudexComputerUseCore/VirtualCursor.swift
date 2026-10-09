import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum VirtualCursorMode: String, Codable {
    case off
    case screenshotOverlay
    case desktopOverlay
    case hybrid
}

public enum VirtualCursorPreset: String, Codable {
    case codexDemo
    case debugTrace

    public var config: VirtualCursorConfig {
        switch self {
        case .codexDemo:
            return .codexDemoDefault
        case .debugTrace:
            return .debugTraceDefault
        }
    }
}

public enum VirtualCursorAccuracy: String, Codable {
    case coordinate
    case semantic
    case approximate
    case inferred

    static func fallback(for kind: String) -> VirtualCursorAccuracy {
        let normalized = kind.lowercased()
        if normalized.contains("type") || normalized.contains("press_key") || normalized.contains("set_value") {
            return .inferred
        }
        if normalized.contains("click.element") || normalized.contains("perform_action") {
            return .semantic
        }
        return .coordinate
    }

    var drawsDirectionalPointer: Bool {
        self == .coordinate || self == .semantic
    }
}

public struct VirtualCursorConfig: Codable {
    public let mode: VirtualCursorMode
    public let style: VirtualCursorStyle
    public let showTrail: Bool
    public let trailLimit: Int
    public let maxAgeSeconds: Double

    public init(
        mode: VirtualCursorMode,
        style: VirtualCursorStyle = .ghostArrow,
        showTrail: Bool? = nil,
        trailLimit: Int,
        maxAgeSeconds: Double
    ) {
        self.mode = mode
        self.style = style
        self.showTrail = showTrail ?? style.defaultShowTrail
        self.trailLimit = trailLimit
        self.maxAgeSeconds = maxAgeSeconds
    }

    private enum CodingKeys: String, CodingKey {
        case mode
        case style
        case showTrail
        case trailLimit
        case maxAgeSeconds
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.mode = try container.decode(VirtualCursorMode.self, forKey: .mode)
        let decodedStyle = try container.decodeIfPresent(VirtualCursorStyle.self, forKey: .style) ?? .ghostArrow
        self.style = decodedStyle
        self.showTrail = try container.decodeIfPresent(Bool.self, forKey: .showTrail) ?? decodedStyle.defaultShowTrail
        self.trailLimit = try container.decode(Int.self, forKey: .trailLimit)
        self.maxAgeSeconds = try container.decode(Double.self, forKey: .maxAgeSeconds)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(mode, forKey: .mode)
        try container.encode(style, forKey: .style)
        try container.encode(showTrail, forKey: .showTrail)
        try container.encode(trailLimit, forKey: .trailLimit)
        try container.encode(maxAgeSeconds, forKey: .maxAgeSeconds)
    }
}

public extension VirtualCursorConfig {
    static let codexDemoDefault = VirtualCursorConfig(
        mode: .hybrid,
        style: .ghostArrow,
        showTrail: false,
        trailLimit: 6,
        maxAgeSeconds: 12
    )

    static let debugTraceDefault = VirtualCursorConfig(
        mode: .hybrid,
        style: .crosshair,
        showTrail: true,
        trailLimit: 12,
        maxAgeSeconds: 45
    )

    static let legacyDefault = VirtualCursorConfig(
        mode: .hybrid,
        style: .secondCursor,
        showTrail: false,
        trailLimit: 8,
        maxAgeSeconds: 45
    )

    var matchesLegacyDefault: Bool {
        mode == Self.legacyDefault.mode
            && style == Self.legacyDefault.style
            && showTrail == Self.legacyDefault.showTrail
            && trailLimit == Self.legacyDefault.trailLimit
            && maxAgeSeconds == Self.legacyDefault.maxAgeSeconds
    }

    var looksLikeLegacyDemoProfile: Bool {
        (mode == .hybrid || mode == .desktopOverlay)
            && style == .secondCursor
            && !showTrail
            && trailLimit == Self.legacyDefault.trailLimit
            && maxAgeSeconds == Self.legacyDefault.maxAgeSeconds
    }
}

public struct VirtualCursorMark: Codable {
    public let pid: Int32
    public let appName: String?
    public let point: ScreenPoint
    public let kind: String
    public let accuracy: VirtualCursorAccuracy
    public let timestamp: Date

    private enum CodingKeys: String, CodingKey {
        case pid
        case appName
        case point
        case kind
        case accuracy
        case timestamp
    }

    public init(
        pid: Int32,
        appName: String?,
        point: ScreenPoint,
        kind: String,
        accuracy: VirtualCursorAccuracy = .coordinate,
        timestamp: Date
    ) {
        self.pid = pid
        self.appName = appName
        self.point = point
        self.kind = kind
        self.accuracy = accuracy
        self.timestamp = timestamp
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.pid = try container.decode(Int32.self, forKey: .pid)
        self.appName = try container.decodeIfPresent(String.self, forKey: .appName)
        self.point = try container.decode(ScreenPoint.self, forKey: .point)
        self.kind = try container.decode(String.self, forKey: .kind)
        self.accuracy = try container.decodeIfPresent(VirtualCursorAccuracy.self, forKey: .accuracy)
            ?? VirtualCursorAccuracy.fallback(for: self.kind)
        self.timestamp = try container.decode(Date.self, forKey: .timestamp)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(pid, forKey: .pid)
        try container.encodeIfPresent(appName, forKey: .appName)
        try container.encode(point, forKey: .point)
        try container.encode(kind, forKey: .kind)
        try container.encode(accuracy, forKey: .accuracy)
        try container.encode(timestamp, forKey: .timestamp)
    }
}

public struct VirtualCursorStatus: Codable {
    public let config: VirtualCursorConfig
    public let trackedAppCount: Int
    public let totalMarkCount: Int
    public let desktopOverlayDriver: String
    public let desktopOverlayReady: Bool
    public let desktopOverlayVisible: Bool
    public let overlayHelperRunning: Bool

    public init(
        config: VirtualCursorConfig,
        trackedAppCount: Int,
        totalMarkCount: Int,
        desktopOverlayDriver: String,
        desktopOverlayReady: Bool,
        desktopOverlayVisible: Bool,
        overlayHelperRunning: Bool
    ) {
        self.config = config
        self.trackedAppCount = trackedAppCount
        self.totalMarkCount = totalMarkCount
        self.desktopOverlayDriver = desktopOverlayDriver
        self.desktopOverlayReady = desktopOverlayReady
        self.desktopOverlayVisible = desktopOverlayVisible
        self.overlayHelperRunning = overlayHelperRunning
    }
}

public struct VirtualCursorOverlayState: Codable {
    public let config: VirtualCursorConfig
    public let marksByPID: [Int32: [VirtualCursorMark]]
    public let updatedAt: Date

    public init(
        config: VirtualCursorConfig,
        marksByPID: [Int32: [VirtualCursorMark]],
        updatedAt: Date
    ) {
        self.config = config
        self.marksByPID = marksByPID
        self.updatedAt = updatedAt
    }
}

public enum VirtualCursor {
    private static let directoryName = "claudex-computer-use"
    private struct ProjectedMark {
        let point: CGPoint
        let kind: String
        let accuracy: VirtualCursorAccuracy
        let timestamp: Date
    }

    private static let lock = NSLock()
    private static let fallbackConfig = VirtualCursorConfig.codexDemoDefault
    private static var config = normalizeLoadedConfig(loadPersistedConfig() ?? fallbackConfig)
    private static var marksByPID: [Int32: [VirtualCursorMark]] = [:]
    private static let storedMarkCap = 64

    public static func currentConfig() -> VirtualCursorConfig {
        lock.lock()
        defer { lock.unlock() }
        pruneLocked(referenceDate: Date())
        return config
    }

    public static func currentStatus() -> VirtualCursorStatus {
        lock.lock()
        defer { lock.unlock() }
        pruneLocked(referenceDate: Date())
        return statusLocked()
    }

    @discardableResult
    public static func updateConfig(
        preset: VirtualCursorPreset? = nil,
        mode: VirtualCursorMode? = nil,
        style: VirtualCursorStyle? = nil,
        showTrail: Bool? = nil,
        trailLimit: Int? = nil,
        maxAgeSeconds: Double? = nil,
        clear: Bool = false
    ) -> VirtualCursorStatus {
        lock.lock()
        defer { lock.unlock() }

        var nextConfig = preset?.config ?? config

        if let mode {
            nextConfig = VirtualCursorConfig(
                mode: mode,
                style: nextConfig.style,
                showTrail: nextConfig.showTrail,
                trailLimit: nextConfig.trailLimit,
                maxAgeSeconds: nextConfig.maxAgeSeconds
            )
        }
        if let style {
            nextConfig = VirtualCursorConfig(
                mode: nextConfig.mode,
                style: style,
                showTrail: showTrail ?? style.defaultShowTrail,
                trailLimit: nextConfig.trailLimit,
                maxAgeSeconds: nextConfig.maxAgeSeconds
            )
        }
        if let showTrail {
            nextConfig = VirtualCursorConfig(
                mode: nextConfig.mode,
                style: nextConfig.style,
                showTrail: showTrail,
                trailLimit: nextConfig.trailLimit,
                maxAgeSeconds: nextConfig.maxAgeSeconds
            )
        }
        if let trailLimit {
            nextConfig = VirtualCursorConfig(
                mode: nextConfig.mode,
                style: nextConfig.style,
                showTrail: nextConfig.showTrail,
                trailLimit: max(1, trailLimit),
                maxAgeSeconds: nextConfig.maxAgeSeconds
            )
        }
        if let maxAgeSeconds {
            nextConfig = VirtualCursorConfig(
                mode: nextConfig.mode,
                style: nextConfig.style,
                showTrail: nextConfig.showTrail,
                trailLimit: nextConfig.trailLimit,
                maxAgeSeconds: max(1, maxAgeSeconds)
            )
        }

        config = nextConfig
        if clear {
            marksByPID.removeAll()
        }

        pruneLocked(referenceDate: Date())
        persistConfigLocked()
        syncOverlayStateLocked(referenceDate: Date())
        if !config.mode.rendersOnDesktop {
            OverlayCursorController.shared.hide()
        }
        return statusLocked()
    }

    public static func record(
        pid: Int32,
        appName: String?,
        point: ScreenPoint,
        kind: String,
        accuracy: VirtualCursorAccuracy = .coordinate
    ) {
        lock.lock()
        defer { lock.unlock() }

        let mark = VirtualCursorMark(
            pid: pid,
            appName: appName,
            point: point,
            kind: kind,
            accuracy: accuracy,
            timestamp: Date()
        )
        var marks = marksByPID[pid, default: []]
        marks.append(mark)
        if marks.count > storedMarkCap {
            marks.removeFirst(marks.count - storedMarkCap)
        }
        marksByPID[pid] = marks
        pruneLocked(referenceDate: mark.timestamp)
        syncOverlayStateLocked(referenceDate: mark.timestamp)
    }

    public static func annotate(_ capture: CapturedWindowImage) throws -> CapturedWindowImage {
        let snapshot: (config: VirtualCursorConfig, marks: [VirtualCursorMark]) = {
            lock.lock()
            defer { lock.unlock() }
            pruneLocked(referenceDate: Date())
            let allMarks = marksByPID[capture.metadata.window.pid, default: []]
            let marks = Array(allMarks.suffix(max(1, config.trailLimit)))
            return (config, marks)
        }()

        guard snapshot.config.mode.rendersOnScreenshot, !snapshot.marks.isEmpty else {
            let metadata = capture.metadata.withVirtualCursor(applied: false, markCount: 0)
            return CapturedWindowImage(metadata: metadata, pngData: capture.pngData)
        }

        let projectedMarks = projectedMarks(snapshot.marks, metadata: capture.metadata)
        guard !projectedMarks.isEmpty else {
            let metadata = capture.metadata.withVirtualCursor(applied: false, markCount: 0)
            return CapturedWindowImage(metadata: metadata, pngData: capture.pngData)
        }

        let annotatedPNGData = try annotatePNGData(
            capture.pngData,
            config: snapshot.config,
            metadata: capture.metadata,
            marks: projectedMarks
        )
        let metadata = capture.metadata.withVirtualCursor(
            applied: true,
            markCount: projectedMarks.count
        )
        return CapturedWindowImage(metadata: metadata, pngData: annotatedPNGData)
    }

    private static func statusLocked() -> VirtualCursorStatus {
        let runtime = OverlayCursorController.shared.runtimeStatus()
        return VirtualCursorStatus(
            config: config,
            trackedAppCount: marksByPID.count,
            totalMarkCount: marksByPID.values.reduce(0) { $0 + $1.count },
            desktopOverlayDriver: runtime.driver,
            desktopOverlayReady: runtime.ready,
            desktopOverlayVisible: runtime.visible,
            overlayHelperRunning: OverlayHelperController.isRunning()
        )
    }

    private static func pruneLocked(referenceDate: Date) {
        let oldest = referenceDate.addingTimeInterval(-config.maxAgeSeconds)
        marksByPID = marksByPID.reduce(into: [:]) { result, item in
            let filtered = item.value.filter { $0.timestamp >= oldest }
            if !filtered.isEmpty {
                result[item.key] = filtered
            }
        }
    }

    private static func syncOverlayStateLocked(referenceDate: Date) {
        // Write state JSON for screenshot overlay annotation. The live desktop
        // cursor is now driven by OverlayCursorController (same-process), so we
        // no longer auto-launch the legacy overlay helper here.
        let state = VirtualCursorOverlayState(
            config: config,
            marksByPID: marksByPID,
            updatedAt: referenceDate
        )
        do {
            let encoder = JSONEncoder()
            let data = try encoder.encode(state)
            try data.write(to: overlayStateURL(), options: .atomic)
        } catch {
            return
        }
    }

    private static func loadPersistedConfig() -> VirtualCursorConfig? {
        guard let data = try? Data(contentsOf: configURL()) else {
            return nil
        }
        return try? JSONDecoder().decode(VirtualCursorConfig.self, from: data)
    }

    private static func normalizeLoadedConfig(_ loaded: VirtualCursorConfig) -> VirtualCursorConfig {
        if loaded.matchesLegacyDefault {
            return .codexDemoDefault
        }
        if loaded.looksLikeLegacyDemoProfile {
            return VirtualCursorConfig(
                mode: loaded.mode,
                style: .ghostArrow,
                showTrail: false,
                trailLimit: VirtualCursorConfig.codexDemoDefault.trailLimit,
                maxAgeSeconds: VirtualCursorConfig.codexDemoDefault.maxAgeSeconds
            )
        }
        return loaded
    }

    private static func persistConfigLocked() {
        guard let data = try? JSONEncoder().encode(config) else {
            return
        }
        try? data.write(to: configURL(), options: .atomic)
    }

    private static func projectedMarks(
        _ marks: [VirtualCursorMark],
        metadata: CapturedWindowMetadata
    ) -> [ProjectedMark] {
        guard metadata.contentRect.width > 0, metadata.contentRect.height > 0 else {
            return []
        }

        let scaleX = Double(metadata.pixelWidth) / metadata.contentRect.width
        let scaleY = Double(metadata.pixelHeight) / metadata.contentRect.height
        let maxX = Double(metadata.pixelWidth)
        let maxY = Double(metadata.pixelHeight)

        return marks.compactMap { mark in
            let x = (mark.point.x - metadata.contentRect.x) * scaleX
            let y = (mark.point.y - metadata.contentRect.y) * scaleY
            guard x >= -32, y >= -32, x <= maxX + 32, y <= maxY + 32 else {
                return nil
            }
            return ProjectedMark(
                point: CGPoint(x: x, y: y),
                kind: mark.kind,
                accuracy: mark.accuracy,
                timestamp: mark.timestamp
            )
        }
    }

    private static func annotatePNGData(
        _ basePNGData: Data,
        config: VirtualCursorConfig,
        metadata: CapturedWindowMetadata,
        marks: [ProjectedMark]
    ) throws -> Data {
        guard
            let source = CGImageSourceCreateWithData(basePNGData as CFData, nil),
            let baseImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw ClaudexComputerUseCoreError.captureFailed("Failed to decode screenshot for virtual cursor overlay.")
        }

        let canvasWidth = metadata.pixelWidth
        let canvasHeight = metadata.pixelHeight
        guard
            let colorSpace = baseImage.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
            let context = CGContext(
                data: nil,
                width: canvasWidth,
                height: canvasHeight,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else {
            throw ClaudexComputerUseCoreError.captureFailed("Failed to create a bitmap context for virtual cursor overlay.")
        }

        let canvasRect = CGRect(x: 0, y: 0, width: canvasWidth, height: canvasHeight)
        context.interpolationQuality = .high
        context.setAllowsAntialiasing(true)
        let drawMarks = marks.map {
            VirtualCursorDrawMark(
                point: $0.point,
                kind: $0.kind,
                accuracy: $0.accuracy,
                timestamp: $0.timestamp
            )
        }
        drawScreenshotWithTopLeftOverlay(baseImage, in: context, canvasRect: canvasRect) { overlayContext in
            VirtualCursorRenderer.draw(
                in: overlayContext,
                config: config,
                marks: drawMarks
            )
        }

        guard let finalImage = context.makeImage() else {
            throw ClaudexComputerUseCoreError.captureFailed("Failed to materialize the virtual cursor overlay image.")
        }
        return try encodePNGData(from: finalImage)
    }

    // CGImage drawing already preserves its pixel orientation in a bitmap context.
    // Only the projected cursor positions use top-left coordinates. Flipping before
    // drawing the base image would invert the screenshot while leaving the cursor
    // in the right place, misleading coordinate-based computer use.
    static func drawScreenshotWithTopLeftOverlay(
        _ image: CGImage,
        in context: CGContext,
        canvasRect: CGRect,
        drawOverlay: (CGContext) -> Void
    ) {
        context.draw(image, in: canvasRect)
        context.saveGState()
        context.translateBy(x: 0, y: canvasRect.height)
        context.scaleBy(x: 1, y: -1)
        drawOverlay(context)
        context.restoreGState()
    }

    private static func encodePNGData(from image: CGImage) throws -> Data {
        let mutableData = NSMutableData()
        guard
            let destination = CGImageDestinationCreateWithData(
                mutableData,
                UTType.png.identifier as CFString,
                1,
                nil
            )
        else {
            throw ClaudexComputerUseCoreError.pngEncodingFailed
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw ClaudexComputerUseCoreError.pngEncodingFailed
        }
        return mutableData as Data
    }

    public static func overlayStateURL() -> URL {
        stateDirectoryURL().appendingPathComponent("virtual-cursor-state.json", isDirectory: false)
    }

    static func configURL() -> URL {
        stateDirectoryURL().appendingPathComponent("virtual-cursor-config.json", isDirectory: false)
    }

    static func overlayPIDFileURL() -> URL {
        stateDirectoryURL().appendingPathComponent("virtual-cursor-overlay.pid", isDirectory: false)
    }

    private static func stateDirectoryURL() -> URL {
        let cachesDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let directory = cachesDirectory.appendingPathComponent(directoryName, isDirectory: true)
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }
}

public extension VirtualCursorMode {
    var rendersOnScreenshot: Bool {
        self == .screenshotOverlay || self == .hybrid
    }

    var rendersOnDesktop: Bool {
        self == .desktopOverlay || self == .hybrid
    }
}

private extension CapturedWindowMetadata {
    func withVirtualCursor(applied: Bool, markCount: Int) -> CapturedWindowMetadata {
        CapturedWindowMetadata(
            window: window,
            requestedScale: requestedScale,
            pointPixelScale: pointPixelScale,
            contentRect: contentRect,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            captureBackend: captureBackend,
            virtualCursorApplied: applied,
            virtualCursorMarkCount: markCount
        )
    }
}

import AppKit
import CoreGraphics
import Darwin
import Foundation
import ImageIO
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

public struct ScreenRect: Codable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public init(_ rect: CGRect) {
        self.init(
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height
        )
    }
}

public struct ShareableWindowInfo: Codable {
    public let windowID: UInt32
    public let pid: Int32
    public let appName: String?
    public let bundleIdentifier: String?
    public let title: String?
    public let frame: ScreenRect
    public let windowLayer: Int
    public let isOnScreen: Bool
    public let isActive: Bool

    public init(
        windowID: UInt32,
        pid: Int32,
        appName: String?,
        bundleIdentifier: String?,
        title: String?,
        frame: ScreenRect,
        windowLayer: Int,
        isOnScreen: Bool,
        isActive: Bool
    ) {
        self.windowID = windowID
        self.pid = pid
        self.appName = appName
        self.bundleIdentifier = bundleIdentifier
        self.title = title
        self.frame = frame
        self.windowLayer = windowLayer
        self.isOnScreen = isOnScreen
        self.isActive = isActive
    }
}

public struct CapturedWindowMetadata: Codable {
    public let window: ShareableWindowInfo
    public let requestedScale: Double
    public let pointPixelScale: Double
    public let contentRect: ScreenRect
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let captureBackend: String
    public let virtualCursorApplied: Bool
    public let virtualCursorMarkCount: Int

    public init(
        window: ShareableWindowInfo,
        requestedScale: Double,
        pointPixelScale: Double,
        contentRect: ScreenRect,
        pixelWidth: Int,
        pixelHeight: Int,
        captureBackend: String,
        virtualCursorApplied: Bool,
        virtualCursorMarkCount: Int
    ) {
        self.window = window
        self.requestedScale = requestedScale
        self.pointPixelScale = pointPixelScale
        self.contentRect = contentRect
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.captureBackend = captureBackend
        self.virtualCursorApplied = virtualCursorApplied
        self.virtualCursorMarkCount = virtualCursorMarkCount
    }
}

public struct CapturedWindowImage {
    public let metadata: CapturedWindowMetadata
    public let pngData: Data

    public init(metadata: CapturedWindowMetadata, pngData: Data) {
        self.metadata = metadata
        self.pngData = pngData
    }

    public func writePNG(to url: URL) throws {
        do {
            try pngData.write(to: url)
        } catch {
            throw ClaudexComputerUseCoreError.fileWriteFailed(url.path)
        }
    }
}

public enum WindowCapture {
    private static let screenCaptureKitTimeout: TimeInterval = 2.5
    private static let screencaptureTimeout: TimeInterval = 3.0

    public static func listWindows(
        pid: Int32? = nil,
        excludeDesktopWindows: Bool = true,
        onScreenWindowsOnly: Bool = false
    ) throws -> [ShareableWindowInfo] {
        guard PermissionManager.screenRecordingTrusted() else {
            throw ClaudexComputerUseCoreError.missingScreenRecordingPermission
        }

        let options = listOptions(
            excludeDesktopWindows: excludeDesktopWindows,
            onScreenWindowsOnly: onScreenWindowsOnly
        )
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            throw ClaudexComputerUseCoreError.captureFailed("CoreGraphics returned no window list.")
        }

        let frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier

        return raw.compactMap { dictionary in
            makeWindowInfo(dictionary, frontmostPID: frontmostPID)
        }
        .filter { window in
            if let pid, window.pid != pid {
                return false
            }

            return window.frame.width > 0 && window.frame.height > 0
        }
        .sorted(by: compareWindows)
    }

    public static func captureWindow(
        pid: Int32,
        windowID: UInt32? = nil,
        scale: Double = 1.0,
        promptForScreenRecording: Bool = false
    ) throws -> CapturedWindowImage {
        guard scale > 0 else {
            throw ClaudexComputerUseCoreError.invalidArgument("capture_window scale must be greater than 0.")
        }
        try Allowlist.require(pid: pid)

        guard PermissionManager.screenRecordingTrusted(prompt: promptForScreenRecording) else {
            throw ClaudexComputerUseCoreError.missingScreenRecordingPermission
        }

        let windows = try listWindows(
            pid: pid,
            excludeDesktopWindows: true,
            onScreenWindowsOnly: false
        )

        guard let targetWindow = preferredWindow(
            from: windows,
            pid: pid,
            windowID: windowID
        ) else {
            throw ClaudexComputerUseCoreError.windowNotFound(pid: pid, windowID: windowID)
        }

        let captureAttempt = try captureImage(for: targetWindow)
        let rawImage = captureAttempt.image
        let requestedWidth = max(1, Int(round(Double(rawImage.width) * scale)))
        let requestedHeight = max(1, Int(round(Double(rawImage.height) * scale)))
        let image = try resizeImageIfNeeded(
            rawImage,
            outputWidth: requestedWidth,
            outputHeight: requestedHeight
        )
        guard let pngData = pngData(from: image) else {
            throw ClaudexComputerUseCoreError.pngEncodingFailed
        }

        let pointPixelScale = pixelScale(for: targetWindow, rawImage: rawImage)

        let metadata = CapturedWindowMetadata(
            window: targetWindow,
            requestedScale: scale,
            pointPixelScale: pointPixelScale,
            contentRect: targetWindow.frame,
            pixelWidth: image.width,
            pixelHeight: image.height,
            captureBackend: captureAttempt.backend,
            virtualCursorApplied: false,
            virtualCursorMarkCount: 0
        )

        let capture = CapturedWindowImage(metadata: metadata, pngData: pngData)
        return try VirtualCursor.annotate(capture)
    }

    private static func preferredWindow(
        from windows: [ShareableWindowInfo],
        pid: Int32,
        windowID: UInt32?
    ) -> ShareableWindowInfo? {
        let matches = windows.filter { window in
            guard window.pid == pid else {
                return false
            }

            if let windowID {
                return window.windowID == windowID
            }

            return window.frame.width > 0 && window.frame.height > 0
        }

        if windowID != nil {
            return matches.first
        }

        return matches.max { lhs, rhs in
            rank(lhs) < rank(rhs)
        }
    }

    private static func makeWindowInfo(
        _ dictionary: [String: Any],
        frontmostPID: pid_t?
    ) -> ShareableWindowInfo? {
        guard
            let windowID = number(from: dictionary[kCGWindowNumber as String])?.uint32Value,
            let pid = number(from: dictionary[kCGWindowOwnerPID as String])?.int32Value,
            let layer = number(from: dictionary[kCGWindowLayer as String])?.intValue
        else {
            return nil
        }

        guard
            let boundsDictionary = dictionary[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
        else {
            return nil
        }

        let app = NSRunningApplication(processIdentifier: pid)
        let appName = string(from: dictionary[kCGWindowOwnerName as String]) ?? app?.localizedName
        let bundleIdentifier = app?.bundleIdentifier
        let title = string(from: dictionary[kCGWindowName as String])
        let isOnScreen = bool(from: dictionary[kCGWindowIsOnscreen as String]) ?? false
        let isActive = frontmostPID == pid && isOnScreen

        return ShareableWindowInfo(
            windowID: windowID,
            pid: pid,
            appName: appName,
            bundleIdentifier: bundleIdentifier,
            title: title,
            frame: ScreenRect(bounds),
            windowLayer: layer,
            isOnScreen: isOnScreen,
            isActive: isActive
        )
    }

    private static func compareWindows(_ lhs: ShareableWindowInfo, _ rhs: ShareableWindowInfo) -> Bool {
        let leftKey = (
            lhs.pid,
            lhs.isActive ? 0 : 1,
            lhs.isOnScreen ? 0 : 1,
            lhs.windowLayer,
            -(lhs.frame.width * lhs.frame.height),
            lhs.windowID
        )
        let rightKey = (
            rhs.pid,
            rhs.isActive ? 0 : 1,
            rhs.isOnScreen ? 0 : 1,
            rhs.windowLayer,
            -(rhs.frame.width * rhs.frame.height),
            rhs.windowID
        )
        return leftKey < rightKey
    }

    private static func rank(_ window: ShareableWindowInfo) -> Double {
        var score = window.frame.width * window.frame.height
        if window.isOnScreen {
            score += 1_000_000
        }
        if window.isActive {
            score += 2_000_000
        }
        return score
    }

    private static func captureImage(
        for window: ShareableWindowInfo
    ) throws -> (image: CGImage, backend: String) {
#if canImport(ScreenCaptureKit)
        if #available(macOS 14.0, *) {
            if let image = try? captureImageViaScreenCaptureKit(window: window) {
                return (image, "screenCaptureKit")
            }
        }
#endif
        return (try captureImageViaScreencapture(windowID: window.windowID), "screencapture")
    }

    private static func pngData(from image: CGImage) -> Data? {
        let bitmap = NSBitmapImageRep(cgImage: image)
        return bitmap.representation(using: .png, properties: [:])
    }

    private static func captureImageViaScreencapture(
        windowID: CGWindowID
    ) throws -> CGImage {
        let temporaryURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("claudex-computer-use-window-\(windowID)-\(UUID().uuidString).png")

        defer {
            try? FileManager.default.removeItem(at: temporaryURL)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = [
            "-l", "\(windowID)",
            "-x",
            "-o",
            temporaryURL.path
        ]

        do {
            try process.run()
        } catch {
            throw ClaudexComputerUseCoreError.captureFailed("Failed to launch screencapture: \(error.localizedDescription)")
        }

        try waitForProcessExit(
            process,
            timeout: screencaptureTimeout,
            operationName: "screencapture"
        )
        guard process.terminationStatus == 0 else {
            throw ClaudexComputerUseCoreError.captureFailed("screencapture exited with status \(process.terminationStatus) while capturing window \(windowID).")
        }

        let rawData: Data
        do {
            rawData = try Data(contentsOf: temporaryURL)
        } catch {
            throw ClaudexComputerUseCoreError.captureFailed("screencapture did not produce a PNG for window \(windowID).")
        }

        guard
            let source = CGImageSourceCreateWithData(rawData as CFData, nil),
            let rawImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw ClaudexComputerUseCoreError.captureFailed("Failed to decode the PNG captured for window \(windowID).")
        }

        return rawImage
    }

#if canImport(ScreenCaptureKit)
    @available(macOS 14.0, *)
    private static func captureImageViaScreenCaptureKit(
        window: ShareableWindowInfo
    ) throws -> CGImage {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<CGImage, Error>?

        let task = Task.detached(priority: .userInitiated) {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    true,
                    onScreenWindowsOnly: false
                )
                guard let scWindow = content.windows.first(where: { $0.windowID == window.windowID }) else {
                    throw ClaudexComputerUseCoreError.windowNotFound(pid: window.pid, windowID: window.windowID)
                }

                let filter = SCContentFilter(desktopIndependentWindow: scWindow)
                let configuration = SCStreamConfiguration()
                let displayScale = backingScaleFactor(for: window)
                configuration.width = max(1, Int(round(window.frame.width * displayScale)))
                configuration.height = max(1, Int(round(window.frame.height * displayScale)))
                configuration.showsCursor = false

                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: configuration
                )
                result = .success(image)
            } catch {
                result = .failure(error)
            }
            semaphore.signal()
        }

        let waitResult = semaphore.wait(timeout: .now() + screenCaptureKitTimeout)
        guard waitResult == .success else {
            task.cancel()
            throw ClaudexComputerUseCoreError.captureFailed(
                "ScreenCaptureKit timed out while capturing window \(window.windowID)."
            )
        }
        guard let result else {
            throw ClaudexComputerUseCoreError.captureFailed("ScreenCaptureKit did not produce a result.")
        }
        return try result.get()
    }
#endif

    private static func waitForProcessExit(
        _ process: Process,
        timeout: TimeInterval,
        operationName: String
    ) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }

        guard process.isRunning else {
            return
        }

        process.terminate()
        Thread.sleep(forTimeInterval: 0.15)
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }

        throw ClaudexComputerUseCoreError.captureFailed("\(operationName) timed out after \(String(format: "%.1f", timeout))s.")
    }

    private static func resizeImageIfNeeded(
        _ rawImage: CGImage,
        outputWidth: Int,
        outputHeight: Int
    ) throws -> CGImage {
        if rawImage.width == outputWidth && rawImage.height == outputHeight {
            return rawImage
        }

        guard let colorSpace = rawImage.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB) else {
            throw ClaudexComputerUseCoreError.captureFailed("Failed to create a color space for image scaling.")
        }

        guard let context = CGContext(
            data: nil,
            width: outputWidth,
            height: outputHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw ClaudexComputerUseCoreError.captureFailed("Failed to allocate a bitmap context for image scaling.")
        }

        context.interpolationQuality = .high
        context.draw(rawImage, in: CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))

        guard let scaled = context.makeImage() else {
            throw ClaudexComputerUseCoreError.captureFailed("Failed to materialize the scaled window image.")
        }

        return scaled
    }

    private static func pixelScale(for window: ShareableWindowInfo, rawImage: CGImage) -> Double {
        guard window.frame.width > 0 else {
            return 1.0
        }

        return Double(rawImage.width) / window.frame.width
    }

    private static func backingScaleFactor(for window: ShareableWindowInfo) -> Double {
        let rect = NSRect(
            x: window.frame.x,
            y: window.frame.y,
            width: window.frame.width,
            height: window.frame.height
        )
        if let screen = NSScreen.screens.first(where: { $0.frame.intersects(rect) }) {
            return Double(screen.backingScaleFactor)
        }
        return Double(NSScreen.main?.backingScaleFactor ?? 2.0)
    }

    private static func listOptions(
        excludeDesktopWindows: Bool,
        onScreenWindowsOnly: Bool
    ) -> CGWindowListOption {
        var options: CGWindowListOption = onScreenWindowsOnly ? .optionOnScreenOnly : .optionAll
        if excludeDesktopWindows {
            options.insert(.excludeDesktopElements)
        }
        return options
    }

    private static func number(from value: Any?) -> NSNumber? {
        switch value {
        case let number as NSNumber:
            return number
        default:
            return nil
        }
    }

    private static func string(from value: Any?) -> String? {
        switch value {
        case let string as String:
            return string
        default:
            return nil
        }
    }

    private static func bool(from value: Any?) -> Bool? {
        switch value {
        case let bool as Bool:
            return bool
        case let number as NSNumber:
            return number.boolValue
        default:
            return nil
        }
    }
}

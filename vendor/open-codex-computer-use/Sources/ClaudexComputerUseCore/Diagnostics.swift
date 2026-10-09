import Foundation

public struct DoctorReport: Codable {
    public let version: String
    public let macOSVersion: String
    public let permissions: PermissionStatus
    public let runningAppCount: Int
    public let allowlistMode: String
    public let allowedBundleIDCount: Int
    public let deniedBundleIDCount: Int
    public let desktopSession: DesktopSessionStatus
    public let virtualCursor: VirtualCursorStatus

    public init(
        version: String,
        macOSVersion: String,
        permissions: PermissionStatus,
        runningAppCount: Int,
        allowlistMode: String,
        allowedBundleIDCount: Int,
        deniedBundleIDCount: Int,
        desktopSession: DesktopSessionStatus,
        virtualCursor: VirtualCursorStatus
    ) {
        self.version = version
        self.macOSVersion = macOSVersion
        self.permissions = permissions
        self.runningAppCount = runningAppCount
        self.allowlistMode = allowlistMode
        self.allowedBundleIDCount = allowedBundleIDCount
        self.deniedBundleIDCount = deniedBundleIDCount
        self.desktopSession = desktopSession
        self.virtualCursor = virtualCursor
    }
}

public enum Diagnostics {
    public static func doctor(
        promptForAccessibility: Bool = false,
        promptForScreenRecording: Bool = false,
        includeBackgroundApps: Bool = true
    ) -> DoctorReport {
        let allowlistConfig = Allowlist.currentConfig()
        return DoctorReport(
            version: ClaudexComputerUseVersion.current,
            macOSVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            permissions: PermissionManager.snapshot(
                promptForAccessibility: promptForAccessibility,
                promptForScreenRecording: promptForScreenRecording
            ),
            runningAppCount: AppDiscovery.listRunningApps(includeBackground: includeBackgroundApps).count,
            allowlistMode: allowlistConfig.mode.rawValue,
            allowedBundleIDCount: allowlistConfig.allowedBundleIDs.count,
            deniedBundleIDCount: allowlistConfig.deniedBundleIDs.count,
            desktopSession: DesktopSessionManager.status(),
            virtualCursor: VirtualCursor.currentStatus()
        )
    }
}

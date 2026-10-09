// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ClaudexComputerUse",
    platforms: [
        .macOS(.v13)  // AXUIElement / CGEvent 全可用；ScreenCaptureKit 需 12.3+
    ],
    products: [
        .library(name: "ClaudexComputerUseCore", targets: ["ClaudexComputerUseCore"]),
        .executable(name: "claudex-computer-use", targets: ["ClaudexComputerUseMCP"]),
        .executable(name: "claudex-computer-use-cli", targets: ["ClaudexComputerUseCLI"]),
        .executable(name: "claudex-computer-use-overlay-helper", targets: ["ClaudexComputerUseOverlayHelper"])
    ],
    targets: [
        .target(
            name: "ClaudexComputerUseCore",
            path: "Sources/ClaudexComputerUseCore"
        ),
        .executableTarget(
            name: "ClaudexComputerUseMCP",
            dependencies: ["ClaudexComputerUseCore"],
            path: "Sources/ClaudexComputerUseMCP"
        ),
        .executableTarget(
            name: "ClaudexComputerUseCLI",
            dependencies: ["ClaudexComputerUseCore"],
            path: "Sources/ClaudexComputerUseCLI"
        ),
        .executableTarget(
            name: "ClaudexComputerUseOverlayHelper",
            dependencies: ["ClaudexComputerUseCore"],
            path: "Sources/ClaudexComputerUseOverlayHelper"
        ),
        .testTarget(
            name: "ClaudexComputerUseCoreTests",
            dependencies: ["ClaudexComputerUseCore"],
            path: "Tests/ClaudexComputerUseCoreTests"
        )
    ]
)

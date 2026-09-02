// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "TRXGuideOverlay",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "OverlayCore", targets: ["OverlayCore"]),
        .executable(name: "TRXGuideOverlayApp", targets: ["TRXGuideOverlayApp"]),
        .executable(name: "OverlayCoreTestRunner", targets: ["OverlayCoreTestRunner"]),
    ],
    targets: [
        .target(
            name: "OverlayCore",
            linkerSettings: [
                .linkedFramework("CoreGraphics"),
            ]
        ),
        .executableTarget(
            name: "TRXGuideOverlayApp",
            dependencies: ["OverlayCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
        .executableTarget(
            name: "OverlayCoreTestRunner",
            dependencies: ["OverlayCore"],
            path: "TestRunner"
        ),
        .testTarget(
            name: "OverlayCoreTests",
            dependencies: ["OverlayCore"],
            swiftSettings: [
                .unsafeFlags([
                    "-F",
                    "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                ]),
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F",
                    "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-framework",
                    "Testing",
                    "-Xlinker",
                    "-rpath",
                    "-Xlinker",
                    "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-Xlinker",
                    "-rpath",
                    "-Xlinker",
                    "/Library/Developer/CommandLineTools/Library/Developer/usr/lib",
                ]),
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)

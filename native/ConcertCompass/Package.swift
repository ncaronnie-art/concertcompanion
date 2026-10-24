// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "ConcertCompass",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "CompassCore", targets: ["CompassCore"]),
               .executable(name: "compass-plan", targets: ["CompassPlanCLI"])],
    targets: [
        .target(name: "CompassCore"),
        .executableTarget(name: "CompassPlanCLI", dependencies: ["CompassCore"]),
        .testTarget(name: "CompassCoreTests", dependencies: ["CompassCore"])
    ]
)

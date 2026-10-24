// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "CompassQualityTest", dependencies: [.package(path: "../native/ConcertCompass")],
    targets: [.executableTarget(name: "QualityCLI", dependencies: [.product(name: "CompassCore", package: "ConcertCompass")])])

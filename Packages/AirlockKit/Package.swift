// swift-tools-version: 6.2
// AirlockKit — all of Airlock's logic, UI-free and unit-tested.
// Only `AirlockEngines` may import FirebaseAILogic (AGENTS.md §5, ADR-08) — it is the only target
// that depends on the Firebase package. Pinned to 12.19.0: the last release with the documented
// HybridModel API (docs/API-NOTES.md §7.6).

import PackageDescription

let package = Package(
    name: "AirlockKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "AirlockCore", targets: ["AirlockCore"]),
        .library(name: "AirlockDetect", targets: ["AirlockDetect"]),
        .library(name: "AirlockRestore", targets: ["AirlockRestore"]),
        .library(name: "AirlockLedger", targets: ["AirlockLedger"]),
        .library(name: "AirlockSeal", targets: ["AirlockSeal"]),
        .library(name: "AirlockPrompts", targets: ["AirlockPrompts"]),
        .library(name: "AirlockEngineMocks", targets: ["AirlockEngineMocks"]),
        .library(name: "AirlockEngines", targets: ["AirlockEngines"]),
        .library(name: "AirlockRoute", targets: ["AirlockRoute"]),
        .library(name: "AirlockStore", targets: ["AirlockStore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/firebase/firebase-ios-sdk", exact: "12.19.0")
    ],
    targets: [
        .target(name: "AirlockCore"),
        .target(name: "AirlockPrompts", dependencies: ["AirlockCore"], resources: [.process("Prompts")]),
        .target(name: "AirlockEngineMocks", dependencies: ["AirlockCore"]),
        // Human review required (CODEOWNERS). The only Firebase AI Logic call site.
        .target(
            name: "AirlockEngines",
            dependencies: [
                "AirlockCore", "AirlockPrompts",
                .product(name: "FirebaseAILogic", package: "firebase-ios-sdk"),
            ]
        ),
        .target(
            name: "AirlockDetect",
            dependencies: ["AirlockCore", "AirlockPrompts"],
            resources: [.process("PatternPacks")]
        ),
        .target(name: "AirlockRestore", dependencies: ["AirlockCore"]),
        .target(name: "AirlockLedger", dependencies: ["AirlockCore"]),
        // Human review required (INV-6): on-device encrypted storage for the entity map, Vault and raw captures.
        .target(name: "AirlockStore", dependencies: ["AirlockCore", "AirlockDetect"]),
        .target(name: "AirlockRoute", dependencies: ["AirlockCore", "AirlockRestore", "AirlockPrompts", "AirlockLedger"]),
        // Human review required (CODEOWNERS). The only module allowed to construct SealedText.
        .target(name: "AirlockSeal", dependencies: ["AirlockCore", "AirlockDetect", "AirlockRestore", "AirlockPrompts"]),

        .testTarget(name: "AirlockCoreTests", dependencies: ["AirlockCore"]),
        .testTarget(name: "AirlockDetectTests", dependencies: ["AirlockDetect", "AirlockCore", "AirlockPrompts", "AirlockEngineMocks"]),
        .testTarget(
            name: "AirlockRouteTests",
            dependencies: ["AirlockRoute", "AirlockCore", "AirlockSeal", "AirlockDetect", "AirlockEngineMocks", "AirlockLedger", "AirlockRestore", "AirlockPrompts"]
        ),
        .testTarget(name: "AirlockStoreTests", dependencies: ["AirlockStore", "AirlockCore", "AirlockDetect"]),
        .testTarget(name: "AirlockPromptsTests", dependencies: ["AirlockPrompts", "AirlockCore", "AirlockSeal", "AirlockDetect"]),
        .testTarget(name: "AirlockEnginesTests", dependencies: ["AirlockEngines", "AirlockCore", "AirlockPrompts", "AirlockSeal", "AirlockDetect"]),
        .testTarget(name: "AirlockRestoreTests", dependencies: ["AirlockRestore", "AirlockCore"]),
        .testTarget(name: "AirlockLedgerTests", dependencies: ["AirlockLedger", "AirlockCore"]),
        .testTarget(
            name: "AirlockSealTests",
            dependencies: ["AirlockSeal", "AirlockDetect", "AirlockRestore", "AirlockCore", "AirlockPrompts", "AirlockEngineMocks"]
        ),
    ],
    swiftLanguageModes: [.v6]
)

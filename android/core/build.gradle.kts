// The privacy engine, ported 1:1 from web/src/engine (TypeScript) and AirlockKit (Swift).
// Pattern packs and prompts are read from the Swift package at build time — one source of truth.
plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
}

kotlin { jvmToolchain(21) }

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

val copyShared by tasks.registering(Sync::class) {
    val kit = layout.projectDirectory.dir("../../Packages/AirlockKit/Sources")
    from(kit.dir("AirlockDetect/PatternPacks")) { include("*.json"); into("airlock/packs") }
    from(kit.dir("AirlockPrompts/Prompts")) { include("*.txt"); into("airlock/prompts") }
    into(layout.buildDirectory.dir("generated/airlockShared"))
}
sourceSets.main { resources.srcDir(copyShared) }

tasks.test {
    useJUnitPlatform()
    systemProperty("airlock.repoRoot", layout.projectDirectory.dir("../..").asFile.canonicalPath)
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}

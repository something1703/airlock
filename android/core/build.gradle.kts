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
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

val copyShared by tasks.registering(Sync::class) {
    val kit = layout.projectDirectory.dir("../../Packages/AirlockKit/Sources")
    from(kit.dir("AirlockDetect/PatternPacks")) { include("*.json"); into("airlock/packs") }
    from(kit.dir("AirlockPrompts/Prompts")) { include("*.txt"); into("airlock/prompts") }
    into(layout.buildDirectory.dir("generated/airlockShared"))
}
// `airlock/prompts/index.txt`: the bundled prompt ids, one per line, sorted — generated from the same files.
val promptIndex by tasks.registering {
    val promptsDir = layout.projectDirectory.dir("../../Packages/AirlockKit/Sources/AirlockPrompts/Prompts")
    val out = layout.buildDirectory.dir("generated/airlockPromptIndex")
    inputs.dir(promptsDir)
    outputs.dir(out)
    doLast {
        val ids = promptsDir.asFile.listFiles().orEmpty().map { it.name }.filter { it.endsWith(".txt") }.map { it.removeSuffix(".txt") }.sorted()
        val file = out.get().file("airlock/prompts/index.txt").asFile
        file.parentFile.mkdirs()
        file.writeText(ids.joinToString("\n") + "\n")
    }
}
sourceSets.main {
    resources.srcDir(copyShared)
    resources.srcDir(promptIndex)
}

tasks.test {
    useJUnitPlatform()
    systemProperty("airlock.repoRoot", layout.projectDirectory.dir("../..").asFile.canonicalPath)
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}

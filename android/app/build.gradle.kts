// Airlock for Android: Compose UI + Firebase AI Logic engines (hybrid: Gemini Nano on device via
// ML Kit / AICore, Gemini in the cloud). The privacy engine itself lives in :core.
plugins {
    id("com.android.application")
    kotlin("plugin.compose")
    kotlin("plugin.serialization")
    id("com.google.gms.google-services")
}

val repoRoot: String = rootDir.resolve("..").canonicalPath

android {
    namespace = "app.airlock.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.airlock.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Judges sideload the APK; it is signed with the debug key until a release key exists (docs/10-SUBMISSION.md).
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    packaging { resources.excludes += setOf("META-INF/{AL2.0,LGPL2.1}") }
    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.all {
            it.useJUnitPlatform()
            it.systemProperty("airlock.repoRoot", repoRoot)
        }
    }
}

kotlin { jvmToolchain(21) }

/**
 * AirlockBench reports for the Evidence screen: eval/reports/<run>/evidence.json → Java resources
 * `airlock/evidence/<run>.json`, plus `index.txt` (run ids, sorted) because resources can't be listed on Android.
 * Same idea as :core's copy of the pattern packs and prompts — one source of truth, read at build time.
 */
abstract class BundleEvidence : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val reports: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun bundle() {
        val dir = outputDir.get().asFile.resolve("airlock/evidence")
        dir.deleteRecursively()
        dir.mkdirs()
        val runs = reports.files.filter { it.isFile && it.name == "evidence.json" }.sortedBy { it.parentFile.name }
        for (f in runs) f.copyTo(dir.resolve("${f.parentFile.name}.json"), overwrite = true)
        dir.resolve("index.txt").writeText(runs.joinToString("") { it.parentFile.name + "\n" })
    }
}

val bundleEvidence by tasks.registering(BundleEvidence::class) {
    reports.from(fileTree(rootDir.resolve("../eval/reports")) { include("*/evidence.json") })
}

androidComponents {
    onVariants { variant ->
        variant.sources.resources?.addGeneratedSourceDirectory(bundleEvidence, BundleEvidence::outputDir)
    }
}

dependencies {
    implementation(project(":core"))

    implementation(platform("com.google.firebase:firebase-bom:35.2.0"))
    implementation("com.google.firebase:firebase-ai")
    implementation("com.google.firebase:firebase-ai-ondevice:16.0.0-beta08")
    implementation("com.google.firebase:firebase-appcheck-playintegrity")
    implementation("com.google.firebase:firebase-appcheck-debug")
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-config")

    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.13.0")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // JVM unit tests (no Robolectric): engines, store and session are Android-free.
    testImplementation(kotlin("test-junit5"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

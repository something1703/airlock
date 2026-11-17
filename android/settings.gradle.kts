// Airlock for Android. `core` is the pure-Kotlin privacy engine (JVM, tested against spec/fixtures);
// `app` is the Compose UI and the Firebase AI Logic engines.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "airlock-android"
include(":core")

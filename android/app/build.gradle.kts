plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Versienummer = buildnummer van GitHub Actions (lokaal 1)
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "nl.floyd.deurbel"
    compileSdk = 34

    defaultConfig {
        applicationId = "nl.floyd.deurbel"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.$buildNumber"
    }

    // Vaste sleutel, zodat elke nieuwe APK over de vorige heen geïnstalleerd kan worden
    signingConfigs {
        create("vast") {
            storeFile = file("deurbel.keystore")
            storePassword = "deurbel123"
            keyAlias = "deurbel"
            keyPassword = "deurbel123"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("vast")
        }
        debug { signingConfig = signingConfigs.getByName("vast") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}

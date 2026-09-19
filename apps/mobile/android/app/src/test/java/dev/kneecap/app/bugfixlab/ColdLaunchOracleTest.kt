package dev.kneecap.app.bugfixlab

import dev.kneecap.app.FirstRunActivity
import dev.kneecap.app.MainActivity
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * bugfix-lab cluster kneecap-android-crash-on-launch — REPRODUCE stage oracle.
 *
 * NOT shipped. This file (and the two testImplementation/testOptions lines in
 * build.gradle it needs) exists only on the fix/kneecap-android-crash-on-launch
 * branch, purely to OBSERVE the reported crash. No Android emulator or
 * physical device is available in this harness (confirmed: the sandbox's own
 * "androidEmulator" capability is disabled by rollout flag, and booting one
 * locally was blocked by the disk-safety classifier once the AVD's real disk
 * need — ~7.2GB for a single system image, independent of configured
 * partition size — left too thin a margin on this machine's ~11GB quota).
 *
 * Robolectric is the substitute: it loads this module's REAL, UNMODIFIED
 * merged AndroidManifest.xml and res/values/styles.xml (via
 * includeAndroidResources=true) and runs FirstRunActivity/MainActivity's
 * REAL onCreate() through the REAL (unshadowed logic) androidx.appcompat
 * theme-validation path — the same check that throws on a device. It does
 * not touch app source; it only observes.
 *
 * FirstRunActivity is the app's declared LAUNCHER activity (see
 * AndroidManifest.xml's intent-filter), i.e. exactly what
 * `adb shell monkey ... android.intent.category.LAUNCHER` would start on a
 * device — this is the activity a cold app-open actually hits first.
 * MainActivity (Capacitor's BridgeActivity) is exercised too since the
 * cluster's error text ("kneecap closed... has a bug") doesn't distinguish
 * which activity a reporter was on, but is NOT required for the oracle's
 * exit code: BridgeActivity's onCreate does real WebView/asset setup that
 * Robolectric may fail on for reasons unrelated to this crash (missing
 * synced www/ assets, WebView shadow gaps), which would be a false PRESENT
 * signal. FirstRunActivity has none of that — plain AppCompatActivity +
 * Button — so it is the clean signal this oracle's exit code is keyed to.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ColdLaunchOracleTest {

    private fun observe(label: String, launch: () -> Unit): Boolean {
        val outFile = File("bugfix-lab-oracle-$label.txt")
        val crashed: Boolean
        val line: String
        val result: Pair<Boolean, String> = try {
            launch()
            Pair(false, "OK: $label completed onCreate (and, where applicable, onResume) with no uncaught exception")
        } catch (t: Throwable) {
            Pair(true, "CRASH: $label threw ${t.javaClass.name}: ${t.message}")
        }
        crashed = result.first
        line = result.second
        outFile.writeText(line + "\n")
        // Gradle only shows test stdout with --info, but the oracle also
        // reads these files directly, so this line is a convenience, not
        // the primary signal.
        println("BUGFIX_LAB_ORACLE $label -> $line")
        return crashed
    }

    @Test
    fun firstRunActivity_coldLaunch_isThePrimarySignal() {
        // Deliberately does NOT assert/fail either way — a JUnit failure
        // here would be indistinguishable from "the harness broke" in
        // Gradle's summary. oracle.sh reads bugfix-lab-oracle-FirstRunActivity.txt.
        observe("FirstRunActivity") {
            Robolectric.buildActivity(FirstRunActivity::class.java).create()
        }
    }

    @Test
    fun mainActivity_coldLaunch_isSupplementaryEvidenceOnly() {
        observe("MainActivity") {
            Robolectric.buildActivity(MainActivity::class.java).create()
        }
    }
}

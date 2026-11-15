package dev.kneecap.app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.util.Log
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.IOException
import kotlin.system.exitProcess

/**
 * Sign in with publik: the Android half of
 * packages/native-bridge/src/publik-host.ts. The gate itself (the screens,
 * the 3-second wallet poll, usage counting) is TypeScript:
 * apps/mobile/src/publik/publik.ts. This plugin gives it:
 *  - launchInfo: the app version, the device, and the launch settings
 *    (extras of the launching intent) named in SETTING_NAMES. Only a
 *    debuggable build reads them: a release build has no test hooks;
 *  - readFile / writeFile / removeFile: noBackupFilesDir/publik/<name>,
 *    mode 0600, for three names only (the credential, the install ID, the
 *    opt-out);
 *  - openBrowser: the sign-in page in a Custom Tab; closeBrowser brings the
 *    app back in front of it when the gate passes while it is still open;
 *  - finishSelfTest: logs the self-test line (logcat tag "publik"), then
 *    ends the app;
 *  - the "foreground" event: the app came back to the front (for example
 *    when the Custom Tab closes);
 *  - the "browserTick" event: every 3 s while the Custom Tab is open. The
 *    WebView's own timers can stall behind the tab; the tick keeps the
 *    3-second wallet poll going;
 *  - showFirstRun: kneecap's first-run screen (FirstRunActivity), once per
 *    install. The web app calls it AFTER the gate, so "Sign in with publik"
 *    is the first screen of a new install (PUBLIK_GATE_MODE=required).
 * Registered in MainActivity.onCreate.
 */
@CapacitorPlugin(name = "PublikGate")
class PublikGatePlugin : Plugin() {
	companion object {
		const val TAG = "publik"

		/** The launch settings the gate reads (debuggable builds only). Nothing else is read. */
		@JvmField
		val SETTING_NAMES = listOf("PUBLIK_SELF_TEST", "PUBLIK_API_BASE_URL", "DO_NOT_TRACK", "PUBLIK_TELEMETRY", "PUBLIK_TELEMETRY_DEBUG")

		/** A debug build (the CI test APK). Launch settings are test hooks: a release build ignores them. */
		@JvmStatic
		fun isDebuggable(context: Context): Boolean =
			(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

		private val ALLOWED_NAMES = Regex("^(apps/[a-z0-9-]+\\.json|telemetry\\.json|consent\\.json)$")
		private val MODE_0600 = "600".toInt(8)

		/** One launch setting: `adb shell am start -n dev.kneecap.app/.FirstRunActivity --es PUBLIK_SELF_TEST 1`. */
		@JvmStatic
		fun launchSetting(intent: Intent?, name: String): String? {
			val extras = intent?.extras ?: return null
			@Suppress("DEPRECATION")
			val value = extras.get(name)?.toString()
			return if (value.isNullOrEmpty()) null else value
		}
	}

	private fun fileFor(name: String?): File? {
		if (name == null || !ALLOWED_NAMES.matches(name)) return null
		return File(File(context.noBackupFilesDir, "publik"), name)
	}

	/** The sign-in Custom Tab is open over the app (openBrowser), as far as this plugin knows. */
	@Volatile
	private var browserOpen = false

	/** The 3-second tick while the Custom Tab is open (main looper). */
	private val tickHandler = Handler(Looper.getMainLooper())
	private val tick = object : Runnable {
		override fun run() {
			if (!browserOpen) return
			notifyListeners("browserTick", JSObject())
			tickHandler.postDelayed(this, 3000)
		}
	}

	private fun startBrowserTicks() {
		tickHandler.removeCallbacks(tick)
		tickHandler.postDelayed(tick, 3000)
	}

	private fun stopBrowserTicks() {
		tickHandler.removeCallbacks(tick)
	}

	override fun handleOnResume() {
		super.handleOnResume()
		browserOpen = false // the app is in front: the tab is closed or behind it
		stopBrowserTicks()
		notifyListeners("foreground", JSObject())
	}

	@PluginMethod
	fun launchInfo(call: PluginCall) {
		val settings = JSObject()
		if (isDebuggable(context)) {
			for (name in SETTING_NAMES) launchSetting(activity?.intent, name)?.let { settings.put(name, it) }
		}
		val version = try {
			context.packageManager.getPackageInfo(context.packageName, 0).versionName
		} catch (e: Exception) {
			null
		}
		val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: ""
		val arch = when {
			abi.startsWith("arm64") -> "arm64"
			abi == "x86_64" -> "x64"
			else -> ""
		}
		val result = JSObject()
		result.put("appVersion", version ?: "")
		result.put("deviceName", Build.MODEL ?: "Android")
		result.put("arch", arch)
		result.put("settings", settings)
		call.resolve(result)
	}

	@PluginMethod
	fun readFile(call: PluginCall) {
		val file = fileFor(call.getString("name")) ?: return call.reject("publik: this file name is not allowed.")
		val result = JSObject()
		if (file.isFile) {
			try {
				result.put("text", file.readText())
			} catch (e: IOException) {
				Log.w(TAG, "could not read ${file.name}")
			}
		}
		call.resolve(result)
	}

	@PluginMethod
	fun writeFile(call: PluginCall) {
		val file = fileFor(call.getString("name"))
		val text = call.getString("text")
		if (file == null || text == null) return call.reject("publik: this file name is not allowed.")
		val result = JSObject()
		try {
			val dir = file.parentFile ?: throw IOException("no folder")
			if (!dir.isDirectory && !dir.mkdirs()) throw IOException("no folder")
			if (call.getBoolean("exclusive", false) == true) {
				if (!file.createNewFile()) {
					result.put("written", false) // the file is there already
					return call.resolve(result)
				}
				Os.chmod(file.path, MODE_0600)
				file.writeText(text)
			} else {
				val tmp = File(dir, "${file.name}.tmp")
				tmp.writeText(text)
				Os.chmod(tmp.path, MODE_0600)
				if (!tmp.renameTo(file)) throw IOException("rename failed")
			}
			result.put("written", true)
		} catch (e: Exception) {
			Log.w(TAG, "could not write ${file.name}")
			result.put("written", false)
		}
		call.resolve(result)
	}

	@PluginMethod
	fun removeFile(call: PluginCall) {
		val file = fileFor(call.getString("name")) ?: return call.reject("publik: this file name is not allowed.")
		if (file.exists() && !file.delete()) Log.w(TAG, "could not delete ${file.name}")
		val result = JSObject()
		result.put("removed", !file.exists())
		call.resolve(result)
	}

	@PluginMethod
	fun showFirstRun(call: PluginCall) {
		if (FirstRunActivity.hasCompletedFirstRun(context)) return call.resolve()
		val intent = Intent(context, FirstRunActivity::class.java).putExtra(FirstRunActivity.EXTRA_SHOW_PRIMER, true)
		startActivityForResult(call, intent, "firstRunClosed")
	}

	/** Get Started (seen) or Back (shows again next time): the app goes on either way. */
	@ActivityCallback
	private fun firstRunClosed(call: PluginCall?, result: ActivityResult) {
		call?.resolve()
	}

	@PluginMethod
	fun openBrowser(call: PluginCall) {
		val uri = call.getString("url")?.let { Uri.parse(it) }
		if (uri == null || (uri.scheme != "https" && uri.scheme != "http")) return call.reject("publik: not a web address.")
		val act = activity ?: return call.reject("publik: the app is not ready.")
		// A Custom Tab without the androidx.browser library: ACTION_VIEW plus the
		// Custom Tabs session extra (developer.chrome.com/docs/android/custom-tabs).
		// A browser without Custom Tabs opens the page as a normal page.
		val intent = Intent(Intent.ACTION_VIEW, uri)
		intent.putExtras(Bundle().apply { putBinder("android.support.customtabs.extra.SESSION", null) })
		act.runOnUiThread {
			try {
				act.startActivity(intent)
				browserOpen = true
				startBrowserTicks()
				call.resolve()
			} catch (e: ActivityNotFoundException) {
				call.reject("publik: no browser on this phone.")
			}
		}
	}

	/** The gate passed while the Custom Tab is still open: bring the app back in front of it. */
	@PluginMethod
	fun closeBrowser(call: PluginCall) {
		val act = activity
		if (!browserOpen || act == null) return call.resolve()
		browserOpen = false
		stopBrowserTicks()
		act.runOnUiThread {
			try {
				act.startActivity(
					Intent(act, MainActivity::class.java)
						.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
				)
			} catch (e: Exception) {
				Log.w(TAG, "could not bring the app in front of the browser")
			}
			call.resolve()
		}
	}

	@PluginMethod
	fun finishSelfTest(call: PluginCall) {
		val line = call.getString("line") ?: "publik self-test: failed: no result"
		Log.i(TAG, line)
		println(line)
		call.resolve()
		Handler(Looper.getMainLooper()).postDelayed({
			activity?.finishAndRemoveTask()
			exitProcess(0)
		}, 200)
	}
}

package dev.kneecap.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
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
 *    (extras of the launching intent) named in SETTING_NAMES;
 *  - readFile / writeFile: noBackupFilesDir/publik/<name>, mode 0600, for
 *    three names only (the credential, the install ID, the opt-out);
 *  - openBrowser: the sign-in page in a Custom Tab;
 *  - finishSelfTest: logs the self-test line (logcat tag "publik"), then
 *    ends the app;
 *  - the "foreground" event: the app came back to the front (for example
 *    when the Custom Tab closes).
 * Registered in MainActivity.onCreate.
 */
@CapacitorPlugin(name = "PublikGate")
class PublikGatePlugin : Plugin() {
	companion object {
		const val TAG = "publik"

		/** The launch settings the gate reads. Nothing else is read. */
		val SETTING_NAMES = listOf("PUBLIK_SELF_TEST", "PUBLIK_API_BASE_URL", "DO_NOT_TRACK", "PUBLIK_TELEMETRY", "PUBLIK_TELEMETRY_DEBUG")

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

		/** A publik self-test run skips the first-run primer (FirstRunActivity), never the sign-in gate. */
		@JvmStatic
		fun selfTestRequested(intent: Intent?): Boolean = launchSetting(intent, "PUBLIK_SELF_TEST") != null
	}

	private fun fileFor(name: String?): File? {
		if (name == null || !ALLOWED_NAMES.matches(name)) return null
		return File(File(context.noBackupFilesDir, "publik"), name)
	}

	override fun handleOnResume() {
		super.handleOnResume()
		notifyListeners("foreground", JSObject())
	}

	@PluginMethod
	fun launchInfo(call: PluginCall) {
		val settings = JSObject()
		for (name in SETTING_NAMES) launchSetting(activity?.intent, name)?.let { settings.put(name, it) }
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
				call.resolve()
			} catch (e: ActivityNotFoundException) {
				call.reject("publik: no browser on this phone.")
			}
		}
	}

	/** A Custom Tab closes when the person closes it; the gate goes on behind it. */
	@PluginMethod
	fun closeBrowser(call: PluginCall) {
		call.resolve()
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

package dev.kneecap.app;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import dev.kneecap.app.stt.WhisperTranscriber;

/**
 * kneecap M3/M10 — the native half of `NativeBridge.capabilities()` (M3) and
 * `NativeBridge.transcribe()` (M10)
 * (packages/native-bridge/src/capacitor-bridge.ts). Mirrors
 * ios/App/App/NativeBridgePlugin.swift for `getDeviceInfo` — `transcribe`
 * has NO iOS counterpart registered yet (see that Swift file's own doc
 * comment for why: adding one before whisper.xcframework is actually
 * embedded would break the M3 CI build for everyone; Android's Java
 * compiles safely without its native library present, iOS's Swift would
 * not).`pickMedia`/`generateProxy`/`exportProject` remain stubbed on the TS
 * side pending M4/M9.
 *
 * Registration: unlike iOS's protocol-based auto-discovery, Capacitor Android
 * requires an explicit `registerPlugin(NativeBridgePlugin.class)` call in
 * MainActivity's onCreate BEFORE `super.onCreate()` — see MainActivity.java.
 * `name = "NativeBridge"` must match the string
 * `registerPlugin<NativeBridgePluginSpec>("NativeBridge")` uses on the TS
 * side. Unlike iOS's manually-maintained `pluginMethods` array, Capacitor
 * Android discovers `@PluginMethod`-annotated methods via reflection — no
 * separate registration step for `transcribe` below.
 */
@CapacitorPlugin(name = "NativeBridge")
public class NativeBridgePlugin extends Plugin {

    @PluginMethod
    public void getDeviceInfo(PluginCall call) {
        Context context = getContext();
        ActivityManager activityManager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo memoryInfo = new ActivityManager.MemoryInfo();
        long ramTierMb = 0;
        if (activityManager != null) {
            activityManager.getMemoryInfo(memoryInfo);
            ramTierMb = memoryInfo.totalMem / (1024 * 1024);
        }

        JSObject result = new JSObject();
        result.put("osVersion", Build.VERSION.RELEASE);
        result.put("deviceModel", Build.MANUFACTURER + " " + Build.MODEL);
        result.put("ramTierMb", ramTierMb);
        call.resolve(result);
    }

    /**
     * kneecap M10. Real plumbing, honestly incomplete native depth — see
     * `dev.kneecap.app.stt.WhisperTranscriber`'s class doc comment for
     * exactly what is and isn't wired yet. Runs off the main thread: even
     * once the two gaps documented there are closed, `whisper_full()` is a
     * synchronous, CPU-bound native call that must never block Capacitor's
     * (UI-thread-adjacent) plugin call dispatch — plan M10 item 7, "Async
     * job with progress. Never block the UI."
     */
    @PluginMethod
    public void transcribe(PluginCall call) {
        String audioUri = call.getString("audioUri");
        String modelSize = call.getString("modelSize", "tiny");
        String languageHint = call.getString("languageHint");
        if (audioUri == null) {
            call.reject("audioUri is required", "IO_ERROR");
            return;
        }

        new Thread(() -> {
            try {
                JSObject result = WhisperTranscriber.transcribe(getContext(), audioUri, modelSize, languageHint);
                call.resolve(result);
            } catch (WhisperTranscriber.NotYetWiredException e) {
                call.reject(e.getMessage(), "NOT_IMPLEMENTED");
            } catch (Exception e) {
                call.reject("transcribe failed: " + e.getMessage(), "IO_ERROR", e);
            }
        }).start();
    }
}

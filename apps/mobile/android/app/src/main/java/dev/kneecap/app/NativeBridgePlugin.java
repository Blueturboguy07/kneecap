package dev.kneecap.app;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * kneecap M3 — the native half of `NativeBridge.capabilities()`
 * (packages/native-bridge/src/capacitor-bridge.ts). Mirrors
 * ios/App/App/NativeBridgePlugin.swift: this is the ONE bridge method wired
 * end-to-end in M3 to prove the JS<->native round trip actually works.
 * `pickMedia`/`generateProxy`/`exportProject`/`transcribe` remain stubbed on
 * the TS side pending M4/M9/M10.
 *
 * Registration: unlike iOS's protocol-based auto-discovery, Capacitor Android
 * requires an explicit `registerPlugin(NativeBridgePlugin.class)` call in
 * MainActivity's onCreate BEFORE `super.onCreate()` — see MainActivity.java.
 * `name = "NativeBridge"` must match the string
 * `registerPlugin<NativeBridgePluginSpec>("NativeBridge")` uses on the TS
 * side.
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
}

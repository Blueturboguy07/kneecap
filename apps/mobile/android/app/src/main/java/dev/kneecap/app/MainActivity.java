package dev.kneecap.app;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;

public class MainActivity extends BridgeActivity {
    /** The M1 spike's plugin is a developer tool: src/debug/java only, so a release build has no such class. */
    private static final String DEBUG_SPIKE_PLUGIN = "dev.kneecap.app.SpikeDiagnosticsPlugin";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // kneecap M3: local (non-npm) plugin registration. Must happen
        // before super.onCreate() — Capacitor Android docs' documented
        // pattern for app-local plugins (mirrors the auto-discovery iOS gets
        // for free via CAPBridgedPlugin's Objective-C runtime reflection).
        registerPlugin(NativeBridgePlugin.class);
        // Sign in with publik — see PublikGatePlugin.kt.
        registerPlugin(PublikGatePlugin.class);
        // kneecap M1 spike ONLY — see SpikeDiagnosticsPlugin.java's header.
        registerDebugPlugin(DEBUG_SPIKE_PLUGIN);
        super.onCreate(savedInstanceState);
    }

    @SuppressWarnings("unchecked")
    private void registerDebugPlugin(String className) {
        try {
            registerPlugin((Class<? extends Plugin>) Class.forName(className));
        } catch (ClassNotFoundException e) {
            // A release build: the developer tool is not in the app.
        }
    }

    private boolean isDebuggable() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // kneecap M1 spike — throwaway deep link (`kneecap-spike://open`)
        // that navigates the already-loaded WebView to spike.html, the
        // hidden diagnostics screen (docs/SPIKE-GUIDE.md has the exact
        // trigger commands). Debug builds only: the intent filter is in
        // src/debug/AndroidManifest.xml. `launchMode="singleTask"`
        // (AndroidManifest.xml, pre-existing M3 setting) is what makes
        // onNewIntent fire on the already-running Activity instead of
        // recreating it. Mirrors SceneDelegate.swift's
        // `navigateToSpikeHarness()` on iOS.
        Uri data = intent.getData();
        if (isDebuggable() && data != null && "kneecap-spike".equals(data.getScheme()) && getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() ->
                    getBridge().getWebView().evaluateJavascript("window.location.href = 'spike.html';", null)
            );
        }
    }
}

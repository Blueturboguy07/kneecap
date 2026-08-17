package dev.kneecap.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // kneecap M3: local (non-npm) plugin registration. Must happen
        // before super.onCreate() — Capacitor Android docs' documented
        // pattern for app-local plugins (mirrors the auto-discovery iOS gets
        // for free via CAPBridgedPlugin's Objective-C runtime reflection).
        registerPlugin(NativeBridgePlugin.class);
        // kneecap M1 spike ONLY — see SpikeDiagnosticsPlugin.java's header.
        registerPlugin(SpikeDiagnosticsPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // kneecap M1 spike — throwaway deep link (`kneecap-spike://open`)
        // that navigates the already-loaded WebView to spike.html, the
        // hidden diagnostics screen (docs/SPIKE-GUIDE.md has the exact
        // trigger commands). `launchMode="singleTask"` (AndroidManifest.xml,
        // pre-existing M3 setting) is what makes onNewIntent fire on the
        // already-running Activity instead of recreating it. Mirrors
        // SceneDelegate.swift's `navigateToSpikeHarness()` on iOS.
        Uri data = intent.getData();
        if (data != null && "kneecap-spike".equals(data.getScheme()) && getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() ->
                    getBridge().getWebView().evaluateJavascript("window.location.href = 'spike.html';", null)
            );
        }
    }
}

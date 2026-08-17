package dev.kneecap.app;

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
        super.onCreate(savedInstanceState);
    }
}

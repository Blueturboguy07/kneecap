package dev.kneecap.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.widget.Button;

import androidx.appcompat.app.AppCompatActivity;

/**
 * kneecap M3 — native first-run screen (plan M3 item 6: "Native chrome that
 * also satisfies store policy: native splash, native first-run/permissions
 * flow"). Launcher activity: if first run is already done, immediately hands
 * off to {@link MainActivity} (Capacitor's BridgeActivity) with no visible
 * flash; otherwise shows this primer once. Mirrors
 * ios/App/App/FirstRunView.swift's SceneDelegate routing.
 *
 * Deliberately requests NO runtime permission — see the doc comment on
 * FirstRunView.swift for why (plan M4 item 2's Photo Picker + SAF fallback
 * need none).
 */
public class FirstRunActivity extends AppCompatActivity {
    private static final String PREFS_NAME = "kneecap.prefs";
    private static final String KEY_COMPLETED = "hasCompletedFirstRun";

    static boolean hasCompletedFirstRun(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getBoolean(KEY_COMPLETED, false);
    }

    private void markCompletedAndContinue() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putBoolean(KEY_COMPLETED, true).apply();
        startMain();
    }

    /** MainActivity gets this launch's extras: the publik launch settings
     *  (PublikGatePlugin.SETTING_NAMES) ride on them. */
    private void startMain() {
        startActivity(new Intent(this, MainActivity.class).putExtras(getIntent()));
        finish();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // A publik self-test run (extra PUBLIK_SELF_TEST) goes straight to the
        // WebView, where the gate's module logs its line and ends the app. It
        // skips only this primer, never the sign-in gate.
        if (hasCompletedFirstRun(this) || PublikGatePlugin.selfTestRequested(getIntent())) {
            startMain();
            return;
        }

        setContentView(R.layout.activity_first_run);
        Button getStarted = findViewById(R.id.getStartedButton);
        getStarted.setOnClickListener(v -> markCompletedAndContinue());
    }
}

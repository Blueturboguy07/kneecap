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
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (hasCompletedFirstRun(this)) {
            startActivity(new Intent(this, MainActivity.class));
            finish();
            return;
        }

        setContentView(R.layout.activity_first_run);
        Button getStarted = findViewById(R.id.getStartedButton);
        getStarted.setOnClickListener(v -> markCompletedAndContinue());
    }
}

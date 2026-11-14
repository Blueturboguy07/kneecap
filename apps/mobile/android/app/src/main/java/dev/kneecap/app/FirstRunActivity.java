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
 * flow"). Two roles:
 * <ul>
 *   <li>Launcher activity: hands off to {@link MainActivity} (Capacitor's
 *   BridgeActivity) at once, with no visible flash.</li>
 *   <li>With {@link #EXTRA_SHOW_PRIMER}: the first-run screen, once per
 *   install. PublikGatePlugin.showFirstRun starts it for a result after
 *   "Sign in with publik", so the gate is the first screen of a new install
 *   (PUBLIK_GATE_MODE=required). Mirrors PublikGatePlugin.swift's
 *   showFirstRun on iOS.</li>
 * </ul>
 *
 * Deliberately requests NO runtime permission — see the doc comment on
 * FirstRunView.swift for why (plan M4 item 2's Photo Picker + SAF fallback
 * need none).
 */
public class FirstRunActivity extends AppCompatActivity {
    private static final String PREFS_NAME = "kneecap.prefs";
    private static final String KEY_COMPLETED = "hasCompletedFirstRun";
    static final String EXTRA_SHOW_PRIMER = "dev.kneecap.app.SHOW_FIRST_RUN";

    static boolean hasCompletedFirstRun(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getBoolean(KEY_COMPLETED, false);
    }

    private void markCompletedAndClose() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putBoolean(KEY_COMPLETED, true).apply();
        setResult(RESULT_OK);
        finish();
    }

    /** Starts the app. A debuggable build passes on the publik launch
     *  settings (PublikGatePlugin.SETTING_NAMES) and nothing else; a release
     *  build passes no extras. */
    private void startMain() {
        Intent main = new Intent(this, MainActivity.class);
        if (PublikGatePlugin.isDebuggable(this)) {
            for (String name : PublikGatePlugin.SETTING_NAMES) {
                String value = PublikGatePlugin.launchSetting(getIntent(), name);
                if (value != null) main.putExtra(name, value);
            }
        }
        startActivity(main);
        finish();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // The launcher: straight to the app. The web app shows the gate, then
        // asks for this screen (EXTRA_SHOW_PRIMER) when the install has not
        // seen it.
        if (!getIntent().getBooleanExtra(EXTRA_SHOW_PRIMER, false)) {
            startMain();
            return;
        }
        if (hasCompletedFirstRun(this)) {
            finish();
            return;
        }

        setContentView(R.layout.activity_first_run);
        Button getStarted = findViewById(R.id.getStartedButton);
        getStarted.setOnClickListener(v -> markCompletedAndClose());
    }
}

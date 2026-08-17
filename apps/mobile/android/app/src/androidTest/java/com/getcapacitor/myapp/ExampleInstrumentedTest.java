package com.getcapacitor.myapp;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Instrumented test, which will execute on an Android device.
 *
 * @see <a href="http://d.android.com/tools/testing">Testing documentation</a>
 */
@RunWith(AndroidJUnit4.class)
public class ExampleInstrumentedTest {

    @Test
    public void useAppContext() throws Exception {
        // Context of the app under test.
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        // Was "com.getcapacitor.app" — stock Capacitor template boilerplate
        // that predates this app's real applicationId (dev.kneecap.app,
        // apps/mobile/android/app/build.gradle) and would fail if this
        // pre-existing test were ever actually run. Fixed in passing while
        // adding M4's androidTest coverage in this same source set.
        assertEquals("dev.kneecap.app", appContext.getPackageName());
    }
}

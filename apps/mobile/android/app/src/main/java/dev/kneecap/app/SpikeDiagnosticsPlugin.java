package dev.kneecap.app;

import android.app.ActivityManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Debug;
import android.os.HandlerThread;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.text.SpannableString;
import android.text.style.ForegroundColorSpan;

import androidx.annotation.NonNull;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Effect;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.OverlayEffect;
import androidx.media3.effect.TextOverlay;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.EditedMediaItemSequence;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.Transformer;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.collect.ImmutableList;

import java.io.File;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * kneecap M1 spike — a SEPARATE, throwaway native plugin from
 * NativeBridgePlugin.java. See packages/native-bridge/src/
 * spike-diagnostics.ts's header for why this is not folded into the
 * production NativeBridge: this is a hand-rolled fixture exporter for a
 * throwaway harness, not the real M9 export pipeline.
 *
 * exportSpikeSequence() uses the two bundled clips at
 * android/app/src/main/assets/spike/{clip-a,clip-b}.mp4 (see
 * scripts/generate-spike-assets.sh) — bundling as a plain Android asset
 * needs no project-file surgery, unlike iOS (see SpikeDiagnosticsPlugin.swift
 * for why iOS generates its clips on-device instead).
 *
 * IMPORTANT, a real plan-risk-register-item-#4 finding, not a shortcut taken
 * here: Media3 Transformer has NO cross-clip video transition/crossfade
 * support as of the latest release checked directly against
 * https://raw.githubusercontent.com/androidx/media/main/RELEASENOTES.md on
 * 2026-08-17 (1.11.0 — no "transition"/crossfade effect entries anywhere in
 * the changelog history). This export is therefore a real, working
 * SEQUENTIAL 2-clip concatenation + a real text overlay (both genuinely
 * exercised), with `crossfadeApplied: false` and an explanatory `note` —
 * that result IS the M1 answer to "can Android stand up a cross-fade
 * compositor in three weeks," not a placeholder.
 */
@UnstableApi
@CapacitorPlugin(name = "SpikeDiagnostics")
public class SpikeDiagnosticsPlugin extends Plugin {

    @PluginMethod
    public void getMemoryFootprint(PluginCall call) {
        long residentBytes = 0;
        ActivityManager activityManager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (activityManager != null) {
            // Standard Android "how much memory does my process actually use"
            // figure — matches what Android Studio's own Profiler reports.
            Debug.MemoryInfo[] infos = activityManager.getProcessMemoryInfo(new int[]{Process.myPid()});
            if (infos != null && infos.length > 0) {
                residentBytes = infos[0].getTotalPss() * 1024L;
            }
        }
        JSObject result = new JSObject();
        result.put("residentBytes", residentBytes);
        call.resolve(result);
    }

    @PluginMethod
    public void exportSpikeSequence(PluginCall call) {
        long start = System.currentTimeMillis();
        File outputDir = new File(getContext().getCacheDir(), "kneecap-spike");
        outputDir.mkdirs();
        File outputFile = new File(outputDir, "spike-export-" + start + ".mp4");

        // Transformer must be constructed AND driven from a thread with a
        // Looper, and its listener callbacks fire on that same thread — a
        // dedicated HandlerThread keeps this off both the Capacitor plugin
        // call thread and the main/UI thread.
        HandlerThread thread = new HandlerThread("kneecap-spike-export");
        thread.start();
        Handler handler = new Handler(thread.getLooper());

        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<ExportResult> resultRef = new AtomicReference<>();
        AtomicReference<String> errorMessageRef = new AtomicReference<>();

        handler.post(() -> {
            try {
                Composition composition = buildSpikeComposition();
                Transformer transformer = new Transformer.Builder(getContext())
                        .addListener(new Transformer.Listener() {
                            @Override
                            public void onCompleted(@NonNull Composition composition, @NonNull ExportResult exportResult) {
                                resultRef.set(exportResult);
                                latch.countDown();
                            }

                            @Override
                            public void onError(@NonNull Composition composition, @NonNull ExportResult exportResult, @NonNull ExportException exportException) {
                                errorMessageRef.set(exportException.getMessage());
                                latch.countDown();
                            }
                        })
                        .build();
                transformer.start(composition, outputFile.getAbsolutePath());
            } catch (Exception e) {
                errorMessageRef.set("Failed to start export: " + e.getMessage());
                latch.countDown();
            }
        });

        boolean completedInTime;
        try {
            // Two ~3s 720p clips + a text overlay is a small job; 60s is a
            // generous ceiling for a mid-tier device, well under this being
            // mistaken for a hang.
            completedInTime = latch.await(60, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            completedInTime = false;
        }
        thread.quitSafely();

        long wallClockMs = System.currentTimeMillis() - start;

        if (!completedInTime) {
            call.resolve(errorResult("Export timed out after 60s."));
            return;
        }

        String errorMessage = errorMessageRef.get();
        if (errorMessage != null) {
            call.resolve(errorResult("Export failed: " + errorMessage));
            return;
        }

        ExportResult exportResult = resultRef.get();
        boolean fileExists = outputFile.exists() && outputFile.length() > 0;
        if (!fileExists) {
            call.resolve(errorResult("Transformer reported success but output file is missing/empty."));
            return;
        }

        JSObject result = new JSObject();
        result.put("ran", true);
        result.put("wallClockMs", (double) wallClockMs);
        result.put("outputDurationMs", exportResult != null ? (double) exportResult.durationMs : JSObject.NULL);
        result.put("outputSizeBytes", (double) outputFile.length());
        result.put("crossfadeApplied", false);
        result.put("textOverlayApplied", true);
        result.put(
                "note",
                "Media3 Transformer has no cross-clip video transition/crossfade support as of 1.11.0 "
                        + "(verified against androidx/media's RELEASENOTES.md on 2026-08-17 — plan risk-register "
                        + "item #4 still holds). This export is a real sequential 2-clip concatenation + text "
                        + "overlay, not a crossfade. A hand-built cross-fade shader (plan M9's fallback for this "
                        + "exact case) was NOT attempted in this spike pass."
        );
        result.put("error", JSObject.NULL);
        call.resolve(result);

        outputFile.delete();
    }

    private JSObject errorResult(String message) {
        JSObject result = new JSObject();
        result.put("ran", false);
        result.put("wallClockMs", JSObject.NULL);
        result.put("outputDurationMs", JSObject.NULL);
        result.put("outputSizeBytes", JSObject.NULL);
        result.put("crossfadeApplied", JSObject.NULL);
        result.put("textOverlayApplied", JSObject.NULL);
        result.put("note", JSObject.NULL);
        result.put("error", message);
        return result;
    }

    private Composition buildSpikeComposition() {
        Effect textOverlayEffect = buildTextOverlayEffect();
        Effects effects = new Effects(ImmutableList.of(), ImmutableList.of(textOverlayEffect));

        EditedMediaItem clipA = new EditedMediaItem.Builder(MediaItem.fromUri("asset:///spike/clip-a.mp4"))
                .setEffects(effects)
                .build();
        EditedMediaItem clipB = new EditedMediaItem.Builder(MediaItem.fromUri("asset:///spike/clip-b.mp4"))
                .setEffects(effects)
                .build();

        EditedMediaItemSequence sequence = new EditedMediaItemSequence.Builder(List.of(clipA, clipB)).build();
        return new Composition.Builder(ImmutableList.of(sequence)).build();
    }

    private Effect buildTextOverlayEffect() {
        SpannableString text = new SpannableString("kneecap M1 spike");
        text.setSpan(new ForegroundColorSpan(Color.WHITE), 0, text.length(), 0);
        TextOverlay textOverlay = TextOverlay.createStaticTextOverlay(text);
        return new OverlayEffect(ImmutableList.of(textOverlay));
    }
}

import Foundation
import AVFAudio
import Capacitor
import UIKit

/// kneecap M3 — the native half of `NativeBridge.capabilities()`
/// (packages/native-bridge/src/capacitor-bridge.ts). This is the ONE bridge
/// method that is genuinely wired end-to-end in M3: everything else on the
/// TS side throws NOT_IMPLEMENTED pending M4/M9/M10. This plugin's whole job
/// is to prove the JS<->native round trip actually works.
///
/// M10 STATUS: no `transcribe` method has been added to this class yet, on
/// purpose — see `WhisperTranscriber.swift`'s header comment in this same
/// directory for the real (unwired) transcription code and exactly why
/// adding a method here first would break this file's CI-verified compile.
/// The Android side of M10 differs here: Java's `native` method
/// declarations compile without a `.so` present, so
/// `NativeBridgePlugin.java` DOES have a real `transcribe` method already
/// (see that file) — Swift + a missing xcframework has no equivalent safe
/// half-step.
///
/// Registration: the previous claim here — that Capacitor discovers local
/// plugins "via Objective-C runtime reflection, no explicit registration
/// needed" — was FALSE for app-target plugins and produced the on-device
/// `"NativeBridge" plugin is not implemented on ios` failure (founder's
/// iPhone, 2026-08-18). App-local plugins must be registered in
/// `capacitorDidLoad` — see `KneecapBridgeViewController` in
/// SceneDelegate.swift. `jsName` below ("NativeBridge") must match the
/// string `registerPlugin<NativeBridgePluginSpec>("NativeBridge")` uses on
/// the TS side (packages/native-bridge/src/capacitor-bridge.ts).
@objc(NativeBridgePlugin)
public class NativeBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeBridgePlugin"
    public let jsName = "NativeBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getDeviceInfo", returnType: CAPPluginReturnPromise),
        // The media-custody root, so the webview can persist
        // container-RELATIVE media paths: iOS rotates the app data
        // container UUID on every app update/reinstall, so any persisted
        // absolute path dies with the next install (found live 2026-08-19 —
        // every saved project's playback broke after an Xcode reinstall).
        CAPPluginMethod(name: "getMediaRoot", returnType: CAPPluginReturnPromise),
        // Dogfood audio bisector (2026-08-19 device-silence campaign): a
        // 440Hz tone rendered by AVAudioEngine — NO webview involved. Web
        // beep silent + native beep audible = the webview's audio output is
        // broken on this device and preview audio must route natively;
        // neither audible = device volume/output-route, not app code.
        CAPPluginMethod(name: "playTestTone", returnType: CAPPluginReturnPromise),
        // Native preview-audio router (2026-08-20): the device bisect proved
        // this webview renders WebAudio silently while native audio works —
        // see NativeAudioPreview.swift. The JS AudioManager hands the whole
        // audible-clip schedule over on play/seek; audioLevel exposes the
        // mix's measured RMS for the #/autotest signal assertion.
        CAPPluginMethod(name: "audioStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "audioStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "audioLevel", returnType: CAPPluginReturnPromise),
        // kneecap M4 — see NativeBridgePlugin+Media.swift for the
        // implementations. `pickMedia` is a normal promise call (resolves
        // once, with the picked+probed handles). `generateProxy` resolves
        // immediately with an acknowledgement and streams its real result
        // via `notifyListeners("proxyProgress", ...)` events instead —
        // Capacitor promise calls can only resolve once, but
        // `NativeBridge.generateProxy()`'s TS contract is an
        // AsyncGenerator<ProxyProgress>, so progress has to ride the
        // separate (well-established, e.g. @capacitor/app's
        // "appStateChange") event-listener mechanism, not the call's own
        // promise.
        CAPPluginMethod(name: "pickMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generateProxy", returnType: CAPPluginReturnPromise),
        // Unlike `generateProxy`, this one is a plain resolve-when-done
        // call — a handful of JPEGs is fast enough that streaming progress
        // isn't worth the complexity (see `ThumbnailStripSpec` in
        // packages/native-bridge/src/types.ts). Added when the ios and
        // android tracks' bridges were unified: Android exposed this
        // dedicated method while iOS only emitted thumbnail paths as a
        // side effect of `generateProxy`; both now exist on both platforms
        // rather than one being an Android-only trap for M7's timeline.
        CAPPluginMethod(name: "generateThumbnails", returnType: CAPPluginReturnPromise),
        // kneecap M9 — see NativeBridgePlugin+Export.swift. Same
        // resolve-immediately-then-stream-events shape as `generateProxy`
        // above (`exportProgress` events keyed by a client-generated
        // `exportId`, since — unlike `generateProxy`'s `assetId` — an
        // export has no other natural per-call domain identifier to filter
        // events on).
        CAPPluginMethod(name: "exportProject", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportCancel", returnType: CAPPluginReturnPromise),
    ]

    /// Retains the `PHPickerViewControllerDelegate` for the duration of an
    /// in-flight `pickMedia` call — `PHPickerViewController.delegate` is
    /// `weak`, so nothing else holds this. See
    /// `NativeBridgePlugin+Media.swift`.
    var activePickerCoordinator: AnyObject?

    /// kneecap M9 — one `EdlExportHandle` per in-flight `exportProject`
    /// call, keyed by the client-generated `exportId`, so a later
    /// `exportCancel(exportId)` call can find and cancel the right one.
    /// Removed from the dictionary once that export reaches a terminal
    /// stage (done/error/cancelled) — see `NativeBridgePlugin+Export.swift`.
    var activeExportHandles: [String: EdlExportHandle] = [:]

    /// The classic `uname()` trick for a real device identifier
    /// ("iPhone15,2") instead of `UIDevice.current.model`'s generic "iPhone".
    /// Falls back to the generic model name in the Simulator, where
    /// `machine` reports the host Mac's architecture instead.
    private func deviceIdentifier() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machineMirror = Mirror(reflecting: systemInfo.machine)
        let identifier = machineMirror.children.reduce("") { partial, element in
            guard let value = element.value as? Int8, value != 0 else { return partial }
            return partial + String(UnicodeScalar(UInt8(value)))
        }
        if identifier.isEmpty || identifier.hasPrefix("x86_64") || identifier.hasPrefix("arm64") {
            return UIDevice.current.model
        }
        return identifier
    }

    /// The native preview-audio mixer — see NativeAudioPreview.swift.
    let audioPreview = NativeAudioPreview()

    @objc func audioStart(_ call: CAPPluginCall) {
        guard let clipsArray = call.getArray("clips") else {
            call.reject("audioStart requires {clips, atSec}")
            return
        }
        let atSec = call.getDouble("atSec") ?? 0
        var clips: [NativeAudioPreview.ClipSchedule] = []
        for entry in clipsArray {
            guard let dict = entry as? [String: Any],
                  let path = dict["path"] as? String else { continue }
            clips.append(NativeAudioPreview.ClipSchedule(
                path: path,
                startSec: (dict["startSec"] as? Double) ?? 0,
                durationSec: (dict["durationSec"] as? Double) ?? 0,
                sourceOffsetSec: (dict["sourceOffsetSec"] as? Double) ?? 0,
                volume: (dict["volume"] as? Double) ?? 1,
                rate: (dict["rate"] as? Double) ?? 1
            ))
        }
        do {
            try audioPreview.start(clips: clips, atSec: atSec)
            call.resolve(["ok": true])
        } catch {
            call.reject("audioStart failed: \(error.localizedDescription)")
        }
    }

    @objc func audioStop(_ call: CAPPluginCall) {
        audioPreview.stop()
        call.resolve(["ok": true])
    }

    @objc func audioLevel(_ call: CAPPluginCall) {
        call.resolve(["rms": audioPreview.outputLevel])
    }

    /// Retains the test-tone engine for the tone's duration (AVAudioEngine
    /// stops the moment it deallocates).
    var testToneEngine: AVAudioEngine?

    @objc func playTestTone(_ call: CAPPluginCall) {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            let sampleRate = 44_100.0
            let duration = 0.8
            let frameCount = AVAudioFrameCount(sampleRate * duration)
            guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
                  let channel = buffer.floatChannelData?[0] else {
                call.reject("test tone: buffer setup failed")
                return
            }
            buffer.frameLength = frameCount
            for frame in 0..<Int(frameCount) {
                channel[frame] = Float(sin(2.0 * Double.pi * 440.0 * Double(frame) / sampleRate)) * 0.4
            }
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            try engine.start()
            player.scheduleBuffer(buffer)
            player.play()
            self.testToneEngine = engine
            DispatchQueue.main.asyncAfter(deadline: .now() + duration + 0.3) { [weak self] in
                engine.stop()
                if self?.testToneEngine === engine { self?.testToneEngine = nil }
            }
            call.resolve(["ok": true])
        } catch {
            call.reject("test tone failed: \(error.localizedDescription)")
        }
    }

    @objc func getMediaRoot(_ call: CAPPluginCall) {
        do {
            let root = try MediaSandbox.rootDirectory()
            call.resolve(["root": root.path])
        } catch {
            call.reject("getMediaRoot failed: \(error.localizedDescription)")
        }
    }

    @objc func getDeviceInfo(_ call: CAPPluginCall) {
        let physicalMemoryBytes = ProcessInfo.processInfo.physicalMemory
        let ramTierMb = Int(physicalMemoryBytes / (1024 * 1024))
        call.resolve([
            "osVersion": UIDevice.current.systemVersion,
            "deviceModel": deviceIdentifier(),
            "ramTierMb": ramTierMb
        ])
    }
}

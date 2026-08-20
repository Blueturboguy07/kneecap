import type { EditorCore } from "@/core";
import { TICKS_PER_SECOND } from "@/wasm";
import { clampRetimeRate, shouldMaintainPitch } from "@/retime/rate";
import type { AudioClipSource } from "@/media/audio";
import { createAudioContext, collectAudioClips } from "@/media/audio";
import {
	buildAudioGainAutomation,
	hasAnimatedVolume,
} from "@/timeline/audio-state";
import { createAudioMasteringChain } from "@/media/audio-mastering";
import {
	getClipTimeAtSourceTime,
	getSourceTimeAtClipTime,
	renderRetimedBuffer,
} from "@/retime";
import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	BufferTarget,
	Conversion,
	Input,
	Mp4OutputFormat,
	Output,
	type WrappedAudioBuffer,
} from "mediabunny";
import {
	createPlayableSource,
	readPlayableBytes,
} from "@/media/playable-source";

export class AudioManager {
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private outputAnalyser: AnalyserNode | null = null;
	private playbackStartTime = 0;
	private playbackStartContextTime = 0;
	private scheduleTimer: number | null = null;
	private lookaheadSeconds = 2;
	private scheduleIntervalMs = 500;
	private clips: AudioClipSource[] = [];
	private sinks = new Map<string, AudioBufferSink>();
	private inputs = new Map<string, Input>();
	/** sourceKeys whose sink init already failed — without this the play
	 *  loop re-attempts (and re-logs) the same failing open every tick
	 *  (observed as endless warn spam on device, 2026-08-19). Cleared with
	 *  the sinks in disposeSinks(). */
	private failedSinkSources = new Set<string>();
	private activeClipIds = new Set<string>();
	private clipIterators = new Map<
		string,
		AsyncGenerator<WrappedAudioBuffer, void, unknown>
	>();
	private queuedSources = new Set<AudioBufferSourceNode>();
	private preparedClipBuffers = new Map<string, Promise<AudioBuffer | null>>();
	private decodedBuffers = new Map<string, Promise<AudioBuffer | null>>();
	private playbackSessionId = 0;
	private lastIsPlaying = false;
	private lastVolume = 1;
	private playbackLatencyCompensationSeconds = 0;
	private unsubscribers: Array<() => void> = [];

	constructor(private editor: EditorCore) {
		this.lastVolume = this.editor.playback.getVolume();

		this.unsubscribers.push(
			this.editor.playback.subscribe(this.handlePlaybackChange),
			this.editor.timeline.subscribe(this.handleTimelineChange),
			this.editor.media.subscribe(this.handleTimelineChange),
			this.editor.playback.onSeek(this.handleSeek),
		);
	}

	dispose(): void {
		this.stopPlayback();
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		this.disposeSinks();
		this.preparedClipBuffers.clear();
		this.decodedBuffers.clear();
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
			this.masterGain = null;
			this.outputAnalyser = null;
		}
	}

	private handlePlaybackChange = (): void => {
		const isPlaying = this.editor.playback.getIsPlaying();
		const volume = this.editor.playback.getVolume();

		if (volume !== this.lastVolume) {
			this.lastVolume = volume;
			this.updateGain();
		}

		if (isPlaying !== this.lastIsPlaying) {
			this.lastIsPlaying = isPlaying;
			if (isPlaying) {
				void this.startPlayback({
					time: this.editor.playback.getCurrentTime() / TICKS_PER_SECOND,
				});
			} else {
				this.stopPlayback();
			}
		}
	};

	private handleSeek = (time: number): void => {
		if (this.editor.playback.getIsScrubbing()) {
			this.stopPlayback();
			return;
		}

		if (this.editor.playback.getIsPlaying()) {
			void this.startPlayback({ time: time / TICKS_PER_SECOND });
			return;
		}

		this.stopPlayback();
	};

	private handleTimelineChange = (): void => {
		this.disposeSinks();
		this.preparedClipBuffers.clear();
		this.decodedBuffers.clear();

		if (!this.editor.playback.getIsPlaying()) return;

		void this.startPlayback({
			time: this.editor.playback.getCurrentTime() / TICKS_PER_SECOND,
		});
	};

	private ensureAudioContext(): AudioContext | null {
		if (this.audioContext) return this.audioContext;
		if (typeof window === "undefined") return null;

		this.audioContext = createAudioContext();
		const { input } = createAudioMasteringChain({
			audioContext: this.audioContext,
			destination: this.audioContext.destination,
		});
		this.masterGain = input;
		this.masterGain.gain.value = this.lastVolume;
		// Parallel analyser tap on the master bus: getOutputRms() below is
		// the strongest headless evidence that audio actually FLOWS ("sinks
		// opened" passed while the founder heard silence, 2026-08-19).
		this.outputAnalyser = this.audioContext.createAnalyser();
		this.outputAnalyser.fftSize = 2048;
		this.masterGain.connect(this.outputAnalyser);
		return this.audioContext;
	}

	/**
	 * The canonical iOS WebAudio unlock ritual, to be called SYNCHRONOUSLY
	 * inside a user-gesture handler (no awaits before it): ensures the
	 * context exists, kicks resume(), and starts a one-sample silent buffer.
	 * WKWebView blesses audio-session activation by gesture affinity; the
	 * engine's own resume happens after async hops in startPlayback, which
	 * is the last known silent-on-device-only failure shape (2026-08-19).
	 * Idempotent and cheap — safe on every play tap.
	 */
	unlock(): void {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;
		if (audioContext.state === "suspended") {
			void audioContext.resume();
		}
		try {
			const silent = audioContext.createBuffer(1, 1, audioContext.sampleRate);
			const node = audioContext.createBufferSource();
			node.buffer = silent;
			node.connect(audioContext.destination);
			node.start(0);
		} catch {
			// Best-effort — a failure here changes nothing about playback.
		}
	}

	/**
	 * Plays a short raw test tone straight through the SAME context and
	 * destination the editor uses — the device-side bisector for "is
	 * WebAudio output working at all in this webview" vs "our graph is
	 * silent". Returns the post-start context state for display.
	 */
	playTestTone({ seconds = 0.8 }: { seconds?: number } = {}): string {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return "none";
		this.unlock();
		try {
			const oscillator = audioContext.createOscillator();
			oscillator.frequency.value = 440;
			const gain = audioContext.createGain();
			gain.gain.value = 0.3;
			oscillator.connect(gain);
			gain.connect(audioContext.destination);
			oscillator.start();
			oscillator.stop(audioContext.currentTime + seconds);
			oscillator.addEventListener("ended", () => {
				oscillator.disconnect();
				gain.disconnect();
			});
		} catch (error) {
			console.error("[soundcheck] tone failed:", error);
		}
		console.error(
			`[soundcheck] state=${audioContext.state} sampleRate=${audioContext.sampleRate} AudioDecoder=${typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder !== "undefined"} ua=${typeof navigator !== "undefined" ? navigator.userAgent : "?"}`,
		);
		return audioContext.state;
	}

	/** RMS of the master bus right now (0 when idle/silent). Diagnostics —
	 *  see the #/autotest sound assertion. */
	getOutputRms(): number {
		if (!this.outputAnalyser) return 0;
		const data = new Float32Array(this.outputAnalyser.fftSize);
		this.outputAnalyser.getFloatTimeDomainData(data);
		let sum = 0;
		for (const v of data) sum += v * v;
		return Math.sqrt(sum / data.length);
	}

	private updateGain(): void {
		if (!this.masterGain) return;
		this.masterGain.gain.value = this.lastVolume;
	}

	private getPlaybackTime(): number {
		if (!this.audioContext) return this.playbackStartTime;
		const elapsed =
			this.audioContext.currentTime - this.playbackStartContextTime;
		return this.playbackStartTime + elapsed;
	}

	private async startPlayback({ time }: { time: number }): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		this.stopPlayback();
		this.playbackSessionId++;
		this.playbackLatencyCompensationSeconds = 0;

		const tracks = this.editor.scenes.getActiveScene().tracks;
		const mediaAssets = this.editor.media.getAssets();
		const duration = this.editor.timeline.getTotalDuration();

		if (duration <= 0) return;

		if (audioContext.state === "suspended") {
			await audioContext.resume();
		}

		this.clips = await collectAudioClips({ tracks, mediaAssets });
		if (!this.editor.playback.getIsPlaying()) return;

		this.playbackStartTime = time;
		this.playbackStartContextTime = audioContext.currentTime;

		this.scheduleUpcomingClips();

		if (typeof window !== "undefined") {
			this.scheduleTimer = window.setInterval(() => {
				this.scheduleUpcomingClips();
			}, this.scheduleIntervalMs);
		}
	}

	private scheduleUpcomingClips(): void {
		if (!this.editor.playback.getIsPlaying()) return;

		const currentTime = this.getPlaybackTime();
		const windowEnd = currentTime + this.lookaheadSeconds;

		for (const clip of this.clips) {
			if (clip.muted) continue;
			if (this.activeClipIds.has(clip.id)) continue;

			const clipEnd = clip.startTime + clip.duration;
			if (clipEnd <= currentTime) continue;
			if (clip.startTime > windowEnd) continue;

			this.activeClipIds.add(clip.id);
			if (this.shouldUsePreparedClipBuffer({ clip })) {
				void this.schedulePreparedClip({
					clip,
					startTime: currentTime,
					sessionId: this.playbackSessionId,
				});
			} else {
				void this.runClipIterator({
					clip,
					startTime: currentTime,
					sessionId: this.playbackSessionId,
				});
			}
		}
	}

	private stopPlayback(): void {
		if (this.scheduleTimer && typeof window !== "undefined") {
			window.clearInterval(this.scheduleTimer);
		}
		this.scheduleTimer = null;

		for (const iterator of this.clipIterators.values()) {
			void iterator.return();
		}
		this.clipIterators.clear();
		this.activeClipIds.clear();

		for (const source of this.queuedSources) {
			try {
				source.stop();
			} catch {}
			source.disconnect();
		}
		this.queuedSources.clear();
	}

	private async runClipIterator({
		clip,
		startTime,
		sessionId,
	}: {
		clip: AudioClipSource;
		startTime: number;
		sessionId: number;
	}): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		const sink = await this.getAudioSink({ clip });
		if (!sink || !this.editor.playback.getIsPlaying()) return;
		if (sessionId !== this.playbackSessionId) return;

		const clipStart = clip.startTime;
		const clipEnd = clip.startTime + clip.duration;
		const playbackTimeAfterSinkReady = this.getPlaybackTime();
		const iteratorStartTime = Math.max(
			startTime,
			clipStart,
			playbackTimeAfterSinkReady,
		);
		if (iteratorStartTime >= clipEnd) {
			return;
		}
		const sourceStartTime =
			clip.trimStart +
			getSourceTimeAtClipTime({
				clipTime: iteratorStartTime - clip.startTime,
				retime: clip.retime,
			});

		const iterator = sink.buffers(sourceStartTime);
		this.clipIterators.set(clip.id, iterator);
		let consecutiveDroppedBufferCount = 0;

		for await (const { buffer, timestamp } of iterator) {
			if (!this.editor.playback.getIsPlaying()) return;
			if (sessionId !== this.playbackSessionId) return;

			const timelineTime =
				clip.startTime +
				getClipTimeAtSourceTime({
					sourceTime: timestamp - clip.trimStart,
					retime: clip.retime,
				});
			if (timelineTime >= clipEnd) break;

			const node = audioContext.createBufferSource();
			node.buffer = buffer;
			if (clip.retime) {
				node.playbackRate.value = clampRetimeRate({ rate: clip.retime.rate });
			}
			const clipGain = audioContext.createGain();
			clipGain.gain.value = clip.volume;
			node.connect(clipGain);
			clipGain.connect(this.masterGain ?? audioContext.destination);

			const startTimestamp =
				this.playbackStartContextTime +
				this.playbackLatencyCompensationSeconds +
				(timelineTime - this.playbackStartTime);

			if (startTimestamp >= audioContext.currentTime) {
				node.start(startTimestamp);
				consecutiveDroppedBufferCount = 0;
			} else {
				const offset = audioContext.currentTime - startTimestamp;
				if (offset < buffer.duration) {
					node.start(audioContext.currentTime, offset);
					consecutiveDroppedBufferCount = 0;
				} else {
					consecutiveDroppedBufferCount += 1;
					if (consecutiveDroppedBufferCount >= 5) {
						const nextCompensationSeconds = Math.max(
							this.playbackLatencyCompensationSeconds,
							Math.min(0.25, offset + 0.01),
						);
						if (
							nextCompensationSeconds >
							this.playbackLatencyCompensationSeconds + 0.001
						) {
							this.playbackLatencyCompensationSeconds = nextCompensationSeconds;
						}
						const resyncStartTime = this.getPlaybackTime();
						this.clipIterators.delete(clip.id);
						void this.runClipIterator({
							clip,
							startTime: resyncStartTime,
							sessionId,
						});
						return;
					}
					continue;
				}
			}

			this.queuedSources.add(node);
			node.addEventListener("ended", () => {
				node.disconnect();
				clipGain.disconnect();
				this.queuedSources.delete(node);
			});

			const aheadTime = timelineTime - this.getPlaybackTime();
			if (aheadTime >= 1) {
				await this.waitUntilCaughtUp({ timelineTime, targetAhead: 1 });
				if (sessionId !== this.playbackSessionId) return;
			}
		}

		this.clipIterators.delete(clip.id);
		// don't remove from activeClipIds - prevents scheduler from restarting this clip
		// the set is cleared on stopPlayback anyway
	}

	private async schedulePreparedClip({
		clip,
		startTime,
		sessionId,
	}: {
		clip: AudioClipSource;
		startTime: number;
		sessionId: number;
	}): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		const buffer = await this.getPreparedClipBuffer({ clip });
		if (!buffer || !this.editor.playback.getIsPlaying()) return;
		if (sessionId !== this.playbackSessionId) return;

		const clipStart = clip.startTime;
		const clipEnd = clip.startTime + clip.duration;
		const playbackTimeAfterReady = this.getPlaybackTime();
		const effectiveStartTime = Math.max(
			startTime,
			clipStart,
			playbackTimeAfterReady,
		);
		if (effectiveStartTime >= clipEnd) {
			return;
		}

		const node = audioContext.createBufferSource();
		node.buffer = buffer;
		const clipGain = audioContext.createGain();
		node.connect(clipGain);
		clipGain.connect(this.masterGain ?? audioContext.destination);

		const startTimestamp =
			this.playbackStartContextTime +
			this.playbackLatencyCompensationSeconds +
			(effectiveStartTime - this.playbackStartTime);
		const clipOffset = effectiveStartTime - clipStart;
		let actualStartTimestamp = startTimestamp;
		let actualClipOffset = clipOffset;

		if (startTimestamp >= audioContext.currentTime) {
			node.start(startTimestamp, clipOffset);
		} else {
			const lateOffset = audioContext.currentTime - startTimestamp;
			actualStartTimestamp = audioContext.currentTime;
			actualClipOffset = clipOffset + lateOffset;
			node.start(actualStartTimestamp, actualClipOffset);
		}

		this.scheduleClipGainAutomation({
			audioContext,
			clip,
			clipGain,
			startTimestamp: actualStartTimestamp,
			startLocalTime: actualClipOffset,
		});

		this.queuedSources.add(node);
		node.addEventListener("ended", () => {
			node.disconnect();
			clipGain.disconnect();
			this.queuedSources.delete(node);
		});
	}

	private waitUntilCaughtUp({
		timelineTime,
		targetAhead,
	}: {
		timelineTime: number;
		targetAhead: number;
	}): Promise<void> {
		return new Promise((resolve) => {
			const checkInterval = setInterval(() => {
				if (!this.editor.playback.getIsPlaying()) {
					clearInterval(checkInterval);
					resolve();
					return;
				}

				const playbackTime = this.getPlaybackTime();
				if (timelineTime - playbackTime < targetAhead) {
					clearInterval(checkInterval);
					resolve();
				}
			}, 100);
		});
	}

	/** Read-only diagnostics (apps/mobile's #/autotest audio verdict —
	 *  speakers can't be heard headlessly, but "context running + sinks
	 *  opened + none failed" is the strongest in-page audio evidence). */
	getStats(): {
		contextState: AudioContextState | "none";
		activeSinks: number;
		failedSinks: number;
		decodedBuffers: number;
		scheduledClips: number;
		activeClips: number;
		queuedSources: number;
	} {
		return {
			contextState: this.audioContext?.state ?? "none",
			activeSinks: this.sinks.size,
			failedSinks: this.failedSinkSources.size,
			decodedBuffers: this.decodedBuffers.size,
			scheduledClips: this.clips.length,
			activeClips: this.activeClipIds.size,
			queuedSources: this.queuedSources.size,
		};
	}

	private disposeSinks(): void {
		for (const iterator of this.clipIterators.values()) {
			void iterator.return();
		}
		this.clipIterators.clear();
		this.activeClipIds.clear();

		for (const input of this.inputs.values()) {
			input.dispose();
		}
		this.inputs.clear();
		this.sinks.clear();
		// Timeline edits can replace a broken source (e.g. re-import) — give
		// failed sources a fresh chance whenever sinks are rebuilt.
		this.failedSinkSources.clear();
	}

	private shouldUsePreparedClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): boolean {
		return (
			// WebKit shipped WebCodecs AudioDecoder YEARS after VideoDecoder —
			// on iOS versions without it the streaming sink can never produce
			// a single buffer (silence, no error). The prepared path decodes
			// through WebAudio's own decoder instead (see decodeClipBuffer's
			// fallback), which every iOS version has.
			typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder ===
				"undefined" ||
			this.hasCurveRetime({ clip }) ||
			hasAnimatedVolume({ element: clip.timelineElement }) ||
			shouldMaintainPitch({
				rate: clip.retime?.rate ?? 1,
				maintainPitch: clip.retime?.maintainPitch,
			})
		);
	}

	private hasCurveRetime({ clip }: { clip: AudioClipSource }): boolean {
		const mode = (clip.retime as { mode?: unknown } | undefined)?.mode;
		return mode === "curve";
	}

	private scheduleClipGainAutomation({
		audioContext,
		clip,
		clipGain,
		startTimestamp,
		startLocalTime,
	}: {
		audioContext: AudioContext;
		clip: AudioClipSource;
		clipGain: GainNode;
		startTimestamp: number;
		startLocalTime: number;
	}): void {
		clipGain.gain.cancelScheduledValues(startTimestamp);
		clipGain.gain.setValueAtTime(clip.volume, startTimestamp);

		if (!hasAnimatedVolume({ element: clip.timelineElement })) {
			return;
		}

		const points = buildAudioGainAutomation({
			element: clip.timelineElement,
			fromLocalTime: startLocalTime,
			toLocalTime: clip.duration,
		});

		if (points.length === 0) {
			return;
		}

		clipGain.gain.setValueAtTime(points[0].gain, startTimestamp);
		for (let index = 1; index < points.length; index++) {
			const point = points[index];
			const pointTimestamp =
				startTimestamp + (point.localTime - startLocalTime);
			if (pointTimestamp < audioContext.currentTime) {
				continue;
			}

			clipGain.gain.linearRampToValueAtTime(point.gain, pointTimestamp);
		}
	}

	private buildPreparedClipCacheKey({
		clip,
	}: {
		clip: AudioClipSource;
	}): string {
		return JSON.stringify({
			id: clip.id,
			sourceKey: clip.sourceKey,
			startTime: clip.startTime,
			duration: clip.duration,
			trimStart: clip.trimStart,
			trimEnd: clip.trimEnd,
			retime: clip.retime ?? null,
		});
	}

	private async getPreparedClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const cacheKey = this.buildPreparedClipCacheKey({ clip });
		const existing = this.preparedClipBuffers.get(cacheKey);
		if (existing) {
			return existing;
		}

		const promise = (async () => {
			const audioContext = this.ensureAudioContext();
			if (!audioContext) {
				return null;
			}

			const decodedBuffer = await this.getDecodedBuffer({ clip });
			if (!decodedBuffer) {
				return null;
			}

			return await renderRetimedBuffer({
				audioContext,
				sourceBuffer: decodedBuffer,
				trimStart: clip.trimStart,
				clipDuration: clip.duration,
				retime: clip.retime,
				maintainPitch: clip.retime?.maintainPitch === true,
			});
		})();

		this.preparedClipBuffers.set(cacheKey, promise);
		return promise;
	}

	private async getDecodedBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const existing = this.decodedBuffers.get(clip.sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.decodeClipBuffer({ clip });
		this.decodedBuffers.set(clip.sourceKey, promise);
		return promise;
	}

	/** Whole-clip decode through WebAudio's OWN decoder — the fallback for
	 *  WebKit builds without WebCodecs AudioDecoder (mediabunny's sink can
	 *  never yield there), and for any mediabunny decode that comes back
	 *  empty. decodeAudioData handles mp4/AAC (the proxy's format) on every
	 *  iOS version. */
	private async decodeClipBufferViaWebAudio({
		clip,
		audioContext,
	}: {
		clip: AudioClipSource;
		audioContext: AudioContext;
	}): Promise<AudioBuffer | null> {
		let bytes: ArrayBuffer;
		try {
			bytes = await readPlayableBytes({
				file: clip.file,
				url: clip.url ?? null,
			});
		} catch (error) {
			console.warn(
				`WebAudio fallback: no bytes to decode (file.size=${clip.file.size}, url=${clip.url ?? "(none)"}):`,
				error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			);
			return null;
		}

		// Audio-only assets (m4a/mp3/wav) decode directly.
		try {
			return await audioContext.decodeAudioData(bytes.slice(0));
		} catch {
			// Fall through — WebKit's decodeAudioData REJECTS movie
			// containers outright (proven in the forced-fallback sim run,
			// 2026-08-19: the video proxy failed here and the device would
			// have stayed silent). Extract the audio track below.
		}

		// Remux the audio track into an audio-only mp4 — a pure PACKET COPY
		// via mediabunny's Conversion (no decoding, so it needs no
		// WebCodecs), then decode that.
		try {
			const input = new Input({
				source: new BlobSource(new Blob([bytes])),
				formats: ALL_FORMATS,
			});
			const target = new BufferTarget();
			const output = new Output({
				format: new Mp4OutputFormat({ fastStart: "in-memory" }),
				target,
			});
			const conversion = await Conversion.init({
				input,
				output,
				video: { discard: true },
			});
			await conversion.execute();
			if (!target.buffer) {
				console.warn("WebAudio fallback: audio remux produced no buffer");
				return null;
			}
			return await audioContext.decodeAudioData(target.buffer);
		} catch (error) {
			console.warn(
				"WebAudio fallback decode failed (audio remux path):",
				error,
			);
			return null;
		}
	}

	private async decodeClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) {
			return null;
		}

		if (
			typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder ===
			"undefined"
		) {
			return this.decodeClipBufferViaWebAudio({ clip, audioContext });
		}

		let input: Input;
		try {
			input = new Input({
				source: createPlayableSource({ file: clip.file, url: clip.url }),
				formats: ALL_FORMATS,
			});
		} catch (error) {
			console.warn("Audio clip has no playable source:", error);
			return null;
		}

		try {
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack) {
				return null;
			}

			const sink = new AudioBufferSink(audioTrack);
			const chunks: AudioBuffer[] = [];
			let totalSamples = 0;

			for await (const { buffer } of sink.buffers(0)) {
				chunks.push(buffer);
				totalSamples += buffer.length;
			}

			if (chunks.length === 0) {
				return this.decodeClipBufferViaWebAudio({ clip, audioContext });
			}

			const targetSampleRate = audioContext.sampleRate;
			const nativeSampleRate = chunks[0].sampleRate;
			const numChannels = Math.min(2, chunks[0].numberOfChannels);
			const nativeChannels = Array.from(
				{ length: numChannels },
				() => new Float32Array(totalSamples),
			);

			let offset = 0;
			for (const chunk of chunks) {
				for (let channel = 0; channel < numChannels; channel++) {
					nativeChannels[channel].set(
						chunk.getChannelData(Math.min(channel, chunk.numberOfChannels - 1)),
						offset,
					);
				}
				offset += chunk.length;
			}

			const outputSamples = Math.ceil(
				totalSamples * (targetSampleRate / nativeSampleRate),
			);
			const offlineContext = new OfflineAudioContext(
				numChannels,
				outputSamples,
				targetSampleRate,
			);
			const nativeBuffer = audioContext.createBuffer(
				numChannels,
				totalSamples,
				nativeSampleRate,
			);

			for (let channel = 0; channel < numChannels; channel++) {
				nativeBuffer.copyToChannel(nativeChannels[channel], channel);
			}

			const sourceNode = offlineContext.createBufferSource();
			sourceNode.buffer = nativeBuffer;
			sourceNode.connect(offlineContext.destination);
			sourceNode.start(0);

			return await offlineContext.startRendering();
		} catch (error) {
			console.warn("Failed to decode clip audio (mediabunny) — trying WebAudio fallback:", error);
			return this.decodeClipBufferViaWebAudio({ clip, audioContext });
		} finally {
			input.dispose();
		}
	}

	private async getAudioSink({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBufferSink | null> {
		const existingSink = this.sinks.get(clip.sourceKey);
		if (existingSink) return existingSink;
		if (this.failedSinkSources.has(clip.sourceKey)) return null;

		try {
			const input = new Input({
				source: createPlayableSource({ file: clip.file, url: clip.url }),
				formats: ALL_FORMATS,
			});
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack) {
				input.dispose();
				return null;
			}

			const sink = new AudioBufferSink(audioTrack);
			this.inputs.set(clip.sourceKey, input);
			this.sinks.set(clip.sourceKey, sink);
			return sink;
		} catch (error) {
			this.failedSinkSources.add(clip.sourceKey);
			console.warn(
				`Failed to initialize audio sink (source: ${
					clip.file.size > 0
						? `file bytes (${clip.file.size})`
						: `url ${clip.url ?? "(none)"}`
				}):`,
				error,
			);
			return null;
		}
	}
}

import { RECORDING_FRAME_RATE, WAV_SAMPLE_RATE } from '@openmeet/protocol';
import { DEFAULT_QUALITY_ID, presetForTrack } from './quality';
import { cameraConstraints, micConstraints, recordedChannels } from './media';
import { watchMic, type MicWarning } from './mic-watch';

export interface SwitchableMediaOptions {
  qualityId?: string;
  isRecording?: () => boolean;
  onTrackReplaced?: (kind: 'audio' | 'video', newTrack: MediaStreamTrack, oldTrack: MediaStreamTrack) => void;
  onMicWarning?: (warning: MicWarning | null) => void;
  /** Two channels when the microphone has them. */
  stereo?: boolean;
}

/**
 * Feature-detect MediaStreamTrackGenerator and MediaStreamTrackProcessor
 * (Insertable Streams for MediaStreamTrack). Chrome desktop and Android support both;
 * iOS Safari has neither.
 */
export function isTrackGeneratorSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator === 'function' &&
    typeof (window as unknown as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function'
  );
}

export function isPhone(): boolean {
  return typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

/**
 * Builds ONE stable output stream from the lobby stream:
 * - Video: MediaStreamTrackGenerator fed by current camera via MediaStreamTrackProcessor.
 *   One persistent writer; switching cancels old reader, closes stray frames, starts reader on new camera.
 * - Audio: AudioContext({ sampleRate: WAV_SAMPLE_RATE }) -> source(mic) -> MediaStreamAudioDestinationNode.
 *   Fixed channel count and sample rate; Chrome resamples on mic swap without sample-rate glitching.
 *
 * In iOS Safari (where MSTG is missing): keeps raw tracks and uses replaceTrack on peers.
 */
export class SwitchableMedia {
  readonly stream: MediaStream;
  readonly isFallback: boolean;

  private _currentCameraTrack: MediaStreamTrack | null = null;
  private _currentMicTrack: MediaStreamTrack | null = null;
  private _activeMicId?: string | undefined;
  private _activeCamId?: string | undefined;
  private currentVideoReader: ReadableStreamDefaultReader<unknown> | null = null;
  private videoWriter: WritableStreamDefaultWriter<unknown> | null = null;
  private audioCtx: AudioContext | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;
  private audioSourceNode: MediaStreamAudioSourceNode | null = null;
  private levelTap: ChannelSplitterNode | null = null;
  private stopMicWatch: (() => void) | null = null;
  private qualityId: string;
  private frameRate: number;
  private echoCancellation: boolean;
  private options: SwitchableMediaOptions;

  constructor(localStream: MediaStream, options: SwitchableMediaOptions = {}) {
    this.options = options;
    const rawCamTrack = localStream.getVideoTracks()[0] ?? null;
    const rawMicTrack = localStream.getAudioTracks()[0] ?? null;
    this.qualityId = options.qualityId ?? (rawCamTrack ? presetForTrack(rawCamTrack).id : DEFAULT_QUALITY_ID);
    // The request rides on the track, so nothing is threaded from the lobby. Asked-for
    // before delivered: a first camera that fell short must not hold the next one back.
    const asked = rawCamTrack?.getConstraints?.().frameRate;
    this.frameRate =
      (typeof asked === 'number' ? asked : asked?.ideal) ||
      rawCamTrack?.getSettings?.().frameRate ||
      RECORDING_FRAME_RATE;
    // Read from the track like the frame rate, asked-for before delivered: a
    // switched-to microphone is processed the way the lobby's was, so what the
    // host was told about this person's audio stays true for the whole call.
    const askedEcho = rawMicTrack?.getConstraints?.().echoCancellation;
    this.echoCancellation = Boolean(
      typeof askedEcho === 'boolean' ? askedEcho : rawMicTrack?.getSettings?.().echoCancellation
    );
    this.isFallback = !isTrackGeneratorSupported();

    this._currentCameraTrack = rawCamTrack;
    this._currentMicTrack = rawMicTrack;
    this._activeMicId = rawMicTrack?.getSettings?.().deviceId;
    this._activeCamId = rawCamTrack?.getSettings?.().deviceId;

    if (this.isFallback) {
      // iOS Safari fallback: keep raw tracks directly
      this.stream = new MediaStream(localStream.getTracks());
      return;
    }

    // --- Stable Video ---
    const MSTG = (window as unknown as { MediaStreamTrackGenerator: new (init: { kind: string }) => MediaStreamTrack & { writable: WritableStream } }).MediaStreamTrackGenerator;
    const generator = new MSTG({ kind: 'video' });
    this.videoWriter = generator.writable.getWriter();

    // The camera's real settings come from the real track, not the generator
    generator.getSettings = () => this._currentCameraTrack?.getSettings?.() ?? {};
    if (typeof generator.getCapabilities === 'function' || rawCamTrack?.getCapabilities) {
      generator.getCapabilities = () => this._currentCameraTrack?.getCapabilities?.() ?? {};
    }
    if (rawCamTrack) {
      generator.enabled = rawCamTrack.enabled;
    }
    this.startVideoPump(rawCamTrack);

    // --- Stable Audio ---
    // One rate for every microphone and every take. The AAC muxer and the WAV
    // writer lock their rate on the first frame, and a device is free to run at
    // 44.1 kHz or, over Bluetooth, 16 kHz; the source node resamples to this.
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new AudioContextClass({ sampleRate: WAV_SAMPLE_RATE });
    // Resume context if suspended
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().catch(() => {});
    }

    this.destinationNode = this.audioCtx.createMediaStreamDestination();
    this.destinationNode.channelCount = recordedChannels(rawMicTrack, options.stereo ?? false);
    this.destinationNode.channelCountMode = 'explicit';

    if (rawMicTrack) {
      this.audioSourceNode = this.audioCtx.createMediaStreamSource(new MediaStream([rawMicTrack]));
      this.audioSourceNode.connect(this.destinationNode);
      if (options.onMicWarning) {
        try {
          const splitter = this.audioCtx.createChannelSplitter(2);
          const analysers = [this.audioCtx.createAnalyser(), this.audioCtx.createAnalyser()];
          analysers.forEach((analyser, channel) => splitter.connect(analyser, channel));
          this.audioSourceNode.connect(splitter);
          this.levelTap = splitter;
          this.stopMicWatch = watchMic(
            analysers,
            () => this._currentMicTrack?.enabled === true,
            options.onMicWarning
          );
        } catch {
          // Warning tap is a courtesy on the join path; an AudioContext missing
          // splitter/analyser nodes still joins and records without throwing.
        }
      }
    }

    const stableAudioTrack = this.destinationNode.stream.getAudioTracks()[0];
    if (stableAudioTrack && rawMicTrack) {
      stableAudioTrack.enabled = rawMicTrack.enabled;
    }

    const tracks: MediaStreamTrack[] = [];
    tracks.push(generator);
    if (stableAudioTrack) tracks.push(stableAudioTrack);
    this.stream = new MediaStream(tracks);
  }

  get currentCameraTrack(): MediaStreamTrack | null {
    return this._currentCameraTrack;
  }

  get currentMicTrack(): MediaStreamTrack | null {
    return this._currentMicTrack;
  }

  get activeMicId(): string | undefined {
    return this._currentMicTrack?.getSettings?.().deviceId ?? this._activeMicId;
  }

  get activeCamId(): string | undefined {
    return this._currentCameraTrack?.getSettings?.().deviceId ?? this._activeCamId;
  }

  private startVideoPump(track: MediaStreamTrack | null) {
    if (!track || !this.videoWriter) return;
    const MSTP = (window as unknown as { MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream } }).MediaStreamTrackProcessor;
    const processor = new MSTP({ track });
    const reader = processor.readable.getReader();
    this.currentVideoReader = reader;
    const writer = this.videoWriter;

    (async () => {
      try {
        while (true) {
          const { done, value: frame } = await reader.read();
          if (done) break;
          if (this.currentVideoReader !== reader) {
            (frame as { close?: () => void })?.close?.();
            break;
          }
          try {
            await writer.write(frame);
          } catch {
            (frame as { close?: () => void })?.close?.();
            break;
          }
        }
      } catch {
        /* stream closed or cancelled */
      }
    })();
  }

  async switchCamera(target: string): Promise<void> {
    const oldTrack = this._currentCameraTrack;
    const qualityId = oldTrack ? presetForTrack(oldTrack).id : this.qualityId;
    this.qualityId = qualityId;

    if (this.isFallback) {
      if (this.options.isRecording?.()) {
        // Known limit: iOS Safari has no MediaStreamTrackGenerator, so a mid-take camera switch would break MediaRecorder; switching waits for the take to end.
        throw new Error('Switch after this take');
      }
      if (oldTrack) oldTrack.stop?.();

      const constraints = cameraConstraints(target, qualityId, this.frameRate);
      const newStream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;

      this._currentCameraTrack = newTrack;
      this._activeCamId = newTrack.getSettings?.().deviceId ?? (target !== 'user' && target !== 'environment' ? target : this._activeCamId);
      if (oldTrack) {
        this.stream.removeTrack(oldTrack);
        this.stream.addTrack(newTrack);
        this.options.onTrackReplaced?.('video', newTrack, oldTrack);
      }
      return;
    }

    const phone = isPhone();
    if (phone && oldTrack) {
      oldTrack.stop?.();
    }

    let newStream: MediaStream;
    try {
      const constraints = cameraConstraints(target, qualityId, this.frameRate);
      newStream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
    } catch (err) {
      if (phone && oldTrack) {
        try {
          const oldDevId = oldTrack.getSettings?.().deviceId;
          const restored = await navigator.mediaDevices.getUserMedia({
            video: cameraConstraints(oldDevId, qualityId, this.frameRate),
            audio: false,
          });
          const restoredTrack = restored.getVideoTracks()[0] ?? null;
          if (restoredTrack) {
            this._currentCameraTrack = restoredTrack;
            this.startVideoPump(restoredTrack);
          }
        } catch {}
      }
      throw err;
    }

    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) return;

    const oldReader = this.currentVideoReader;
    this.currentVideoReader = null;
    if (oldReader) {
      try {
        await oldReader.cancel();
      } catch {}
    }

    this._currentCameraTrack = newTrack;
    this._activeCamId = newTrack.getSettings?.().deviceId ?? (target !== 'user' && target !== 'environment' ? target : this._activeCamId);
    this.startVideoPump(newTrack);

    if (!phone && oldTrack) {
      oldTrack.stop?.();
    }
  }

  async switchMic(deviceId: string): Promise<void> {
    if (this.isFallback) {
      if (this.options.isRecording?.()) {
        // Known limit: iOS Safari has no MediaStreamTrackGenerator, so a mid-take mic switch would break MediaRecorder; switching waits for the take to end.
        throw new Error('Switch after this take');
      }
      const oldTrack = this._currentMicTrack;
      const constraints = micConstraints(deviceId, this.echoCancellation);
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) return;

      this._currentMicTrack = newTrack;
      this._activeMicId = newTrack.getSettings?.().deviceId ?? deviceId;
      if (oldTrack) {
        this.stream.removeTrack(oldTrack);
        this.stream.addTrack(newTrack);
        this.options.onTrackReplaced?.('audio', newTrack, oldTrack);
        oldTrack.stop?.();
      }
      return;
    }

    const oldTrack = this._currentMicTrack;
    const constraints = micConstraints(deviceId, this.echoCancellation);
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) return;

    if (this.audioSourceNode && this.audioCtx && this.destinationNode) {
      this.audioSourceNode.disconnect();
      const newSource = this.audioCtx.createMediaStreamSource(new MediaStream([newTrack]));
      newSource.connect(this.destinationNode);
      if (this.levelTap) newSource.connect(this.levelTap);
      this.audioSourceNode = newSource;
    }

    this._currentMicTrack = newTrack;
    this._activeMicId = newTrack.getSettings?.().deviceId ?? deviceId;
    if (oldTrack) {
      oldTrack.stop?.();
    }
  }

  setAudioEnabled(enabled: boolean): void {
    this.stream.getAudioTracks().forEach((t) => (t.enabled = enabled));
    if (this._currentMicTrack) {
      this._currentMicTrack.enabled = enabled;
    }
  }

  setVideoEnabled(enabled: boolean): void {
    this.stream.getVideoTracks().forEach((t) => (t.enabled = enabled));
    if (this._currentCameraTrack) {
      this._currentCameraTrack.enabled = enabled;
    }
  }

  stop(): void {
    this.stopMicWatch?.();
    this.stopMicWatch = null;
    if (this.currentVideoReader) {
      try {
        this.currentVideoReader.cancel();
      } catch {}
      this.currentVideoReader = null;
    }
    if (this.videoWriter) {
      try {
        this.videoWriter.close();
      } catch {}
      this.videoWriter = null;
    }
    if (this.audioSourceNode) {
      this.audioSourceNode.disconnect();
      this.audioSourceNode = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this._currentCameraTrack?.stop?.();
    this._currentMicTrack?.stop?.();
    this.stream?.getTracks?.().forEach((t) => t.stop?.());
  }
}

/**
 * Soundboard: play prepared audio into the call while recording.
 *
 * Mixing model — the important decision here:
 *
 *   mic ─┬─────────────────────────────► PcmRecorder  (WAV master: MIC ONLY)
 *        └─► [mix] ◄─ pads ─────────────► every peer + MP4 + backup (what everyone hears)
 *
 * The WAV master stays mic-only. A sting mixed into the master is baked in
 * forever and can never be re-timed, and the host already HAS the pad files at
 * full quality — so recording them again would be strictly worse than recording
 * *when* each one fired. Each trigger drops a chapter marker instead.
 *
 * Files are read locally and never uploaded, consistent with the rest of openMeet.
 */

import { WAV_SAMPLE_RATE } from '@openmeet/protocol';
import { playLocally } from './speaker';

/** Seconds a fading pad takes to come in when fired and to go out when stopped. */
export const PAD_FADE_S = 1.5;

export interface Pad {
  id: string;
  name: string;
  durationMs: number;
  /** Starts over each time it reaches its end, until it is stopped. */
  loop?: boolean;
  /** Comes in and goes out over PAD_FADE_S instead of cutting. */
  fade?: boolean;
}

type Ctor = new (options?: AudioContextOptions) => AudioContext;

export class MediaBoard {
  private ctx: AudioContext;
  private dest: MediaStreamAudioDestinationNode;
  private monitor: MediaStreamAudioDestinationNode;
  private stopMonitor: () => void;
  private buffers = new Map<string, AudioBuffer>();
  private playing = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; fadingOut?: true }>();
  private endListeners = new Set<(id: string) => void>();
  private _pads: Pad[] = [];
  private seq = 0;

  constructor(micStream: MediaStream, ctxCtor?: Ctor) {
    const C = ctxCtor ?? ((globalThis as unknown as { AudioContext: Ctor }).AudioContext);
    // The mix takes the microphone's place in the MP4, so it runs at the rate
    // the WAV master is recorded at, not at the output device's.
    this.ctx = new C({ sampleRate: WAV_SAMPLE_RATE });
    this.dest = this.ctx.createMediaStreamDestination();
    // The mic always feeds the mix; pads are added on top when they fire.
    this.ctx.createMediaStreamSource(micStream).connect(this.dest);
    // What the person who fires a pad hears: the pads alone, played by an element
    // so they go to the speaker that person chose. Not this graph's own output:
    // the browser suspends a graph whose output device goes away, and this graph
    // is the microphone everyone hears and the MP4 records.
    this.monitor = this.ctx.createMediaStreamDestination();
    this.stopMonitor = playLocally(this.monitor.stream);
  }

  get pads(): Pad[] {
    return this._pads;
  }

  /** The mic+pads mix: sent to every peer and recorded in place of the mic. */
  get outputTrack(): MediaStreamTrack | undefined {
    return this.dest.stream.getAudioTracks()[0];
  }

  async load(file: File): Promise<Pad> {
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    const id = `pad${++this.seq}`;
    this.buffers.set(id, buf);
    const pad: Pad = { id, name: file.name, durationMs: Math.round(buf.duration * 1000) };
    this._pads = [...this._pads, pad];
    return pad;
  }

  /** Fire a pad. Re-triggering restarts it rather than stacking copies. */
  play(id: string): void {
    const buf = this.buffers.get(id);
    if (!buf) return;
    this.cut(id);
    const pad = this._pads.find((p) => p.id === id);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = pad?.loop ?? false;
    const gain = this.ctx.createGain();
    if (pad?.fade) {
      const now = this.ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(1, now + PAD_FADE_S);
    }
    src.connect(gain);
    gain.connect(this.dest);
    // Monitor locally too, or the host can't hear what they just fired.
    gain.connect(this.monitor);
    src.onended = () => this.ended(id);
    src.start();
    this.playing.set(id, { src, gain });
  }

  /**
   * Stop a pad. One that fades goes out over PAD_FADE_S and counts as playing
   * until it is silent; stopping it again while it goes out cuts it.
   */
  stop(id: string): void {
    const p = this.playing.get(id);
    if (!p) return;
    if (p.fadingOut || !this._pads.find((x) => x.id === id)?.fade) return this.cut(id);
    p.fadingOut = true;
    const now = this.ctx.currentTime;
    p.gain.gain.cancelScheduledValues(now);
    p.gain.gain.setValueAtTime(p.gain.gain.value, now);
    p.gain.gain.linearRampToValueAtTime(0, now + PAD_FADE_S);
    // onended fires once the fade has run, and tells the listeners then.
    p.src.stop(now + PAD_FADE_S);
  }

  private cut(id: string): void {
    const p = this.playing.get(id);
    if (!p) return;
    try {
      p.src.onended = null;
      p.src.stop();
    } catch {
      /* already finished */
    }
    this.ended(id);
  }

  /** A pad that is playing changes at once: turned off, it runs to its end and stops. */
  setLoop(id: string, loop: boolean): void {
    this._pads = this._pads.map((p) => (p.id === id ? { ...p, loop } : p));
    const p = this.playing.get(id);
    if (p) p.src.loop = loop;
  }

  /** Read when the pad is fired (the way in) and when it is stopped (the way out). */
  setFade(id: string, fade: boolean): void {
    this._pads = this._pads.map((p) => (p.id === id ? { ...p, fade } : p));
  }

  isPlaying(id: string): boolean {
    return this.playing.has(id);
  }

  /** Called whenever a pad stops, by itself or by stop(). Returns an unsubscribe. */
  onPadEnded(listener: (id: string) => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  private ended(id: string): void {
    this.playing.delete(id);
    for (const l of this.endListeners) l(id);
  }

  close(): void {
    for (const id of [...this.playing.keys()]) this.cut(id);
    this.stopMonitor();
    void this.ctx.close();
  }
}

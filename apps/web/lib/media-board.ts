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

export interface Pad {
  id: string;
  name: string;
  durationMs: number;
}

type Ctor = new () => AudioContext;

export class MediaBoard {
  private ctx: AudioContext;
  private dest: MediaStreamAudioDestinationNode;
  private buffers = new Map<string, AudioBuffer>();
  private playing = new Map<string, AudioBufferSourceNode>();
  private endListeners = new Set<(id: string) => void>();
  private _pads: Pad[] = [];
  private seq = 0;

  constructor(micStream: MediaStream, ctxCtor?: Ctor) {
    const C = ctxCtor ?? ((globalThis as unknown as { AudioContext: Ctor }).AudioContext);
    this.ctx = new C();
    this.dest = this.ctx.createMediaStreamDestination();
    // The mic always feeds the mix; pads are added on top when they fire.
    this.ctx.createMediaStreamSource(micStream).connect(this.dest);
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
    this.stop(id);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.dest);
    // Monitor locally too, or the host can't hear what they just fired.
    src.connect(this.ctx.destination);
    src.onended = () => this.ended(id);
    src.start();
    this.playing.set(id, src);
  }

  stop(id: string): void {
    const src = this.playing.get(id);
    if (!src) return;
    try {
      src.onended = null;
      src.stop();
    } catch {
      /* already finished */
    }
    this.ended(id);
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
    for (const id of [...this.playing.keys()]) this.stop(id);
    void this.ctx.close();
  }
}

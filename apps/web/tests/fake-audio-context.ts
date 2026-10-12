import { vi } from 'vitest';

/** What the level meters use of Web Audio: one context, a source and an analyser per stream. */
export class FakeAnalyser {
  fftSize = 2048;
  /** Every sample of the next reading. */
  level = 0;
  connect = vi.fn();
  getFloatTimeDomainData(into: Float32Array): void {
    into.fill(this.level);
  }
}

export class FakeSource {
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(readonly stream: MediaStream) {}
}

export class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  readonly destination = {};
  sources: FakeSource[] = [];
  analysers: FakeAnalyser[] = [];
  close = vi.fn(() => Promise.resolve());
  createMediaStreamDestination = vi.fn();
  constructor() {
    FakeAudioContext.made.push(this);
  }
  createMediaStreamSource(stream: MediaStream): FakeSource {
    // A real context refuses a stream that has no audio track.
    if ((stream as unknown as { noAudio?: boolean }).noAudio) throw new Error('no audio track');
    const source = new FakeSource(stream);
    this.sources.push(source);
    return source;
  }
  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
}

export type MicWarning = 'silent';

// About -80 dBFS: above a dead input's digital zeros, below a live mic's own noise floor.
export const MIC_DEAD_PEAK = 0.0001;

// How long an input stays dead before it is reported, so a pause or a cable swap is not.
export const MIC_SILENT_AFTER_MS = 10_000;

// Slow enough to cost nothing beside the encoder; shorter than the window, so no gap at 48 kHz.
export const MIC_POLL_MS = 300;

// What the participant sees above the stage when their own mic is in trouble.
export const MIC_WARNING_TEXT: Record<MicWarning, string> = {
  silent: `No sound from your microphone for ${MIC_SILENT_AFTER_MS / 1000} seconds. Check it’s plugged in and not muted, or select another microphone.`,
};

// Window size in samples (341 ms at 48 kHz), ensuring consecutive polls overlap.
const MIC_WINDOW_SAMPLES = 16384;

export function createMicVerdict(): (peak: number | null, nowMs: number) => MicWarning | null {
  let deadSinceMs: number | null = null;

  return (peak: number | null, nowMs: number): MicWarning | null => {
    if (peak === null) {
      deadSinceMs = null;
      return null;
    }

    if (peak < MIC_DEAD_PEAK) {
      if (deadSinceMs === null) {
        deadSinceMs = nowMs;
      }
      if (nowMs - deadSinceMs >= MIC_SILENT_AFTER_MS) {
        return 'silent';
      }
      return null;
    }

    deadSinceMs = null;
    return null;
  };
}

export interface LevelTap {
  fftSize: number;
  readonly context: { readonly state: string };
  getFloatTimeDomainData(into: Float32Array): void;
}

export function watchMic(
  taps: readonly LevelTap[],
  micOn: () => boolean,
  onChange: (warning: MicWarning | null) => void
): () => void {
  for (const tap of taps) {
    tap.fftSize = MIC_WINDOW_SAMPLES;
  }
  const buffer = new Float32Array(MIC_WINDOW_SAMPLES);
  const verdict = createMicVerdict();
  let lastReported: MicWarning | null = null;

  const timer = setInterval(() => {
    let peak: number | null = null;
    if (micOn()) {
      let maxPeak = 0;
      for (const tap of taps) {
        // A context that is not running feeds the recorders silence while its analyser keeps its last window.
        if (tap.context.state === 'running') {
          tap.getFloatTimeDomainData(buffer);
          for (const v of buffer) {
            const abs = Math.abs(v);
            if (abs > maxPeak) {
              maxPeak = abs;
            }
          }
        }
      }
      peak = maxPeak;
    }

    const currentVerdict = verdict(peak, Date.now());
    if (currentVerdict !== lastReported) {
      lastReported = currentVerdict;
      onChange(currentVerdict);
    }
  }, MIC_POLL_MS);

  return () => {
    clearInterval(timer);
  };
}

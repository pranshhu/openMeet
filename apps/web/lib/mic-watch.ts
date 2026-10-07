export type MicWarning = 'silent' | 'clipping';

// About -80 dBFS: above a dead input's digital zeros, below a live mic's own noise floor.
export const MIC_DEAD_PEAK = 0.0001;

// How long an input stays dead before it is reported, so a pause or a cable swap is not.
export const MIC_SILENT_AFTER_MS = 10_000;

// A sample above this is clipped. The lobby's micCheck uses the same level, so the two cannot disagree.
export const MIC_CLIP_PEAK = 0.98;

// How many clipped polls trigger a clipping warning, so a cough or bumped stand is not.
export const MIC_CLIP_HITS = 3;

// A clean stretch this long forgets the clipped polls counted so far, and clears the note.
export const MIC_CLIP_CLEAR_MS = 10_000;

// Slow enough to cost nothing beside the encoder; shorter than the window, so no gap at 48 kHz.
export const MIC_POLL_MS = 300;

// What the participant sees above the stage when their own mic is in trouble.
export const MIC_WARNING_TEXT: Record<MicWarning, string> = {
  silent: `No sound from your microphone for ${MIC_SILENT_AFTER_MS / 1000} seconds. Check it’s plugged in and not muted, or select another microphone.`,
  clipping:
    'Your microphone is clipping. Lower the input gain or move back from it — the distortion goes into the recording.',
};

// Window size in samples (341 ms at 48 kHz), ensuring consecutive polls overlap.
const MIC_WINDOW_SAMPLES = 16384;

export function createMicVerdict(): (peak: number | null, nowMs: number) => MicWarning | null {
  let deadSinceMs: number | null = null;
  let clipHits = 0;
  let lastClippedMs = 0;

  return (peak: number | null, nowMs: number): MicWarning | null => {
    if (peak === null) {
      deadSinceMs = null;
      clipHits = 0;
      return null;
    }

    if (clipHits > 0 && nowMs - lastClippedMs >= MIC_CLIP_CLEAR_MS) {
      clipHits = 0;
    }

    if (peak > MIC_CLIP_PEAK) {
      clipHits += 1;
      lastClippedMs = nowMs;
    }

    if (peak < MIC_DEAD_PEAK) {
      if (deadSinceMs === null) {
        deadSinceMs = nowMs;
      }
      if (nowMs - deadSinceMs >= MIC_SILENT_AFTER_MS) {
        return 'silent';
      }
    } else {
      deadSinceMs = null;
    }

    if (clipHits >= MIC_CLIP_HITS) {
      return 'clipping';
    }

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

/**
 * Ready sounds for the media board: a pad without bringing a file.
 *
 * Each one is computed in the page when it is asked for, from sine tones and
 * noise. The site ships no audio for them, and nothing is made for a sound
 * nobody adds.
 */

import { WAV_SAMPLE_RATE } from '@openmeet/protocol';
import { f32ToS24LE, wavHeader } from './wav';

export interface BoardSound {
  /** On its button, on the pad, and in the chapter marker a fired pad drops. */
  name: string;
  /** Runs under speech: its pad starts out set to loop and to fade. */
  bed?: true;
  /** One channel at `rate`, every sample between -1 and 1. */
  render(rate: number): Float32Array;
}

const TAU = 2 * Math.PI;

function fill(rate: number, seconds: number, at: (t: number) => number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = at(i / rate);
  return out;
}

/** A sine that starts at `t0`, comes in over 5 ms so it does not click, and dies away. */
function ping(t: number, t0: number, hz: number, decay: number): number {
  const x = t - t0;
  return x < 0 ? 0 : Math.sin(TAU * hz * x) * Math.min(1, x / 0.005) * Math.exp(-x * decay);
}

/** A drum: a sine whose pitch falls from twice `hz` while it dies away. */
function thump(t: number, t0: number, hz: number): number {
  const x = t - t0;
  return x < 0 ? 0 : Math.sin(TAU * hz * x * (1 + Math.exp(-x * 30))) * Math.exp(-x * 18);
}

/** Three rising notes. */
function chime(rate: number): Float32Array {
  return fill(rate, 1.5, (t) => 0.25 * (ping(t, 0, 784, 7) + ping(t, 0.12, 1047, 7) + ping(t, 0.24, 1319, 7)));
}

/** Two drums and a cymbal. */
function rimshot(rate: number): Float32Array {
  let last = 0;
  return fill(rate, 1.2, (t) => {
    const noise = Math.random() * 2 - 1;
    // The difference of two noise samples keeps the hiss and drops the rumble.
    const hiss = t < 0.36 ? 0 : ((noise - last) / 2) * Math.exp(-(t - 0.36) * 9);
    last = noise;
    return 0.4 * thump(t, 0, 160) + 0.4 * thump(t, 0.18, 120) + 0.25 * hiss;
  });
}

// Every frequency is a multiple of 0.25 Hz, so each partial is a whole number
// of cycles in four seconds and the end runs into the start without a click.
// The pairs a quarter and a half hertz apart make the chord swell slowly.
const BED_PARTIALS: readonly (readonly [hz: number, level: number])[] = [
  [110, 0.035],
  [110.25, 0.035],
  [165, 0.025],
  [220, 0.02],
  [220.5, 0.02],
  [277.25, 0.012],
];

/** Four seconds of a quiet chord, made to loop. */
function bed(rate: number): Float32Array {
  return fill(rate, 4, (t) => {
    let v = 0;
    for (const [hz, level] of BED_PARTIALS) v += level * Math.sin(TAU * hz * t);
    return v;
  });
}

// A pad has no volume of its own and is mixed over the voice at full gain, so
// the level is set here: the stings peak near 0.4 and the bed near 0.13.
export const BOARD_SOUNDS: readonly BoardSound[] = [
  { name: 'Chime', render: chime },
  { name: 'Rimshot', render: rimshot },
  { name: 'Soft bed', bed: true, render: bed },
];

/** The sound as a WAV file the board can load, at the rate the board mixes at. */
export function soundFile(sound: BoardSound): File {
  const pcm = f32ToS24LE(sound.render(WAV_SAMPLE_RATE));
  const header = wavHeader({ sampleRate: WAV_SAMPLE_RATE, channels: 1, bitDepth: 24 }, pcm.byteLength);
  return new File([header, pcm], sound.name, { type: 'audio/wav' });
}

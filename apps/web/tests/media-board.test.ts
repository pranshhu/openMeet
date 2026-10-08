import { describe, it, expect, vi } from 'vitest';
import { MediaBoard, PAD_FADE_S } from '@/lib/media-board';

/**
 * The load-bearing property: the mic and the pads meet in ONE output track,
 * which is what every peer hears and what gets recorded.
 */
function fakeCtx() {
  const destTrack = { kind: 'audio', id: 'mixed' } as MediaStreamTrack;
  const started: string[] = [];
  const sources: { onended: (() => void) | null; loop: boolean }[] = [];
  const dest = { stream: { getAudioTracks: () => [destTrack] } };
  const gains: {
    gain: {
      value: number;
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
      cancelScheduledValues: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
  }[] = [];
  const ctx = {
    started,
    sources,
    gains,
    dest,
    currentTime: 10,
    createGain: () => {
      const node = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
      };
      gains.push(node);
      return node;
    },
    createMediaStreamDestination: () => dest,
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createBufferSource: () => {
      const node = {
        buffer: null as AudioBuffer | null,
        loop: false,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        start: () => started.push('start'),
        // A stop with a time is one that waits for a fade.
        stop: (when?: number) => started.push(when === undefined ? 'stop' : `stop@${when}`),
      };
      sources.push(node);
      return node;
    },
    decodeAudioData: async () => ({ duration: 2.5 }) as AudioBuffer,
    destination: {},
    close: vi.fn(),
  };
  return ctx;
}

function mkBoard() {
  const ctx = fakeCtx();
  const mic = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
  const board = new MediaBoard(mic, function () { return ctx as unknown as AudioContext; } as never);
  return { board, ctx };
}

const file = (name: string) =>
  ({ name, arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as File;

describe('MediaBoard', () => {
  it('mixes the mic into its output so the peer hears both', () => {
    const { ctx } = mkBoard();
    const micNode = ctx.createMediaStreamSource.mock.results[0]!.value as { connect: unknown };
    expect(micNode.connect).toHaveBeenCalledWith(ctx.dest);
  });

  it('exposes a mixed output track distinct from the mic', () => {
    const { board } = mkBoard();
    expect(board.outputTrack?.id).toBe('mixed');
  });

  it('runs the mix audio context at 48 kHz', () => {
    const Ctor = vi.fn(function () { return fakeCtx(); });
    const mic = {
      getAudioTracks: () => [{ kind: 'audio', getSettings: () => ({ sampleRate: 44100 }) }],
    } as unknown as MediaStream;
    new MediaBoard(mic, Ctor as never);
    expect(Ctor).toHaveBeenCalledWith({ sampleRate: 48000 });
  });

  it('falls back to global AudioContext when ctxCtor is omitted', () => {
    const origCtx = (globalThis as any).AudioContext;
    const globalCtor = vi.fn(function () { return fakeCtx(); });
    (globalThis as any).AudioContext = globalCtor;
    try {
      const mic = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
      new MediaBoard(mic);
      expect(globalCtor).toHaveBeenCalledWith({ sampleRate: 48000 });
    } finally {
      (globalThis as any).AudioContext = origCtx;
    }
  });

  it('loads pads with their real duration', async () => {
    const { board } = mkBoard();
    const pad = await board.load(file('sting.wav'));
    expect(pad.name).toBe('sting.wav');
    expect(pad.durationMs).toBe(2500);
    expect(board.pads).toHaveLength(1);
  });

  it('re-triggering restarts a pad instead of stacking copies', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('a.wav'));
    board.play(pad.id);
    board.play(pad.id);
    // second play stops the first before starting again
    expect(ctx.started).toEqual(['start', 'stop', 'start']);
    expect(board.isPlaying(pad.id)).toBe(true);
  });

  it('plays pads both to the mix destination and to the local destination', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('a.wav'));
    board.play(pad.id);
    const srcNode = ctx.sources[0] as any;
    const gainNode = ctx.gains[0]!;
    expect(srcNode.connect).toHaveBeenCalledWith(gainNode);
    expect(gainNode.connect).toHaveBeenCalledWith(ctx.dest);
    expect(gainNode.connect).toHaveBeenCalledWith(ctx.destination);
  });

  it('stop is a no-op for a pad that is not playing', async () => {
    const { board } = mkBoard();
    const pad = await board.load(file('a.wav'));
    expect(() => board.stop(pad.id)).not.toThrow();
    expect(board.isPlaying(pad.id)).toBe(false);
  });

  it('ignores an unknown pad id', () => {
    const { board, ctx } = mkBoard();
    board.play('nope');
    expect(ctx.started).toEqual([]);
  });

  it('tells listeners when a pad ends, whether it ran out or was stopped', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('a.wav'));
    const ended: string[] = [];
    const off = board.onPadEnded((id) => ended.push(id));

    board.play(pad.id);
    ctx.sources[0]!.onended?.();
    expect(board.isPlaying(pad.id)).toBe(false);
    board.play(pad.id);
    board.stop(pad.id);
    expect(ended).toEqual([pad.id, pad.id]);

    off();
    board.play(pad.id);
    board.stop(pad.id);
    expect(ended).toHaveLength(2);
  });

  it('plays a pad set to loop as a loop, and any other pad once', async () => {
    const { board, ctx } = mkBoard();
    const bed = await board.load(file('bed.wav'));
    const sting = await board.load(file('sting.wav'));
    board.setLoop(bed.id, true);
    expect(board.pads.find((p) => p.id === bed.id)?.loop).toBe(true);

    board.play(bed.id);
    board.play(sting.id);
    expect(ctx.sources[0]!.loop).toBe(true);
    expect(ctx.sources[1]!.loop).toBe(false);
  });

  it('turns looping on and off for a pad that is already playing', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('bed.wav'));
    board.play(pad.id);
    board.setLoop(pad.id, true);
    expect(ctx.sources[0]!.loop).toBe(true);
    board.setLoop(pad.id, false);
    expect(ctx.sources[0]!.loop).toBe(false);
  });

  it('brings a fading pad in from silence, and any other pad in at once', async () => {
    const { board, ctx } = mkBoard();
    const bed = await board.load(file('bed.wav'));
    const sting = await board.load(file('sting.wav'));
    board.setFade(bed.id, true);
    expect(board.pads.find((p) => p.id === bed.id)?.fade).toBe(true);

    board.play(bed.id);
    board.play(sting.id);
    expect(ctx.gains[0]!.gain.setValueAtTime).toHaveBeenCalledWith(0, 10);
    expect(ctx.gains[0]!.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 10 + PAD_FADE_S);
    expect(ctx.gains[1]!.gain.setValueAtTime).not.toHaveBeenCalled();
    expect(ctx.gains[1]!.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
  });

  it('fades a fading pad out when stopped, and counts it as playing until it is silent', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('bed.wav'));
    board.setFade(pad.id, true);
    const ended: string[] = [];
    board.onPadEnded((id) => ended.push(id));
    board.play(pad.id);
    ctx.gains[0]!.gain.value = 0.4; // stopped part-way through its way in

    board.stop(pad.id);
    expect(ctx.gains[0]!.gain.cancelScheduledValues).toHaveBeenCalledWith(10);
    expect(ctx.gains[0]!.gain.setValueAtTime).toHaveBeenLastCalledWith(0.4, 10);
    expect(ctx.gains[0]!.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 10 + PAD_FADE_S);
    expect(ctx.started).toEqual(['start', `stop@${10 + PAD_FADE_S}`]);
    expect(board.isPlaying(pad.id)).toBe(true);
    expect(ended).toEqual([]);

    ctx.sources[0]!.onended?.();
    expect(board.isPlaying(pad.id)).toBe(false);
    expect(ended).toEqual([pad.id]);
  });

  it('cuts a pad that is fading out when it is stopped again', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('bed.wav'));
    board.setFade(pad.id, true);
    const ended: string[] = [];
    board.onPadEnded((id) => ended.push(id));
    board.play(pad.id);

    board.stop(pad.id);
    board.stop(pad.id);
    expect(ctx.started).toEqual(['start', `stop@${10 + PAD_FADE_S}`, 'stop']);
    expect(board.isPlaying(pad.id)).toBe(false);
    expect(ended).toEqual([pad.id]);
    // A real node still fires `ended` after a cut; the listeners were already told.
    ctx.sources[0]!.onended?.();
    expect(ended).toEqual([pad.id]);
  });

  // The switch is read when the pad is stopped, so it reaches one that is playing.
  it('reads Fade when a pad is stopped, not only when it is fired', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('bed.wav'));
    board.play(pad.id);
    board.setFade(pad.id, true);
    board.stop(pad.id);
    expect(ctx.started).toEqual(['start', 'stop@11.5']);

    board.stop(pad.id);
    board.play(pad.id);
    board.setFade(pad.id, false);
    board.stop(pad.id);
    expect(ctx.started).toEqual(['start', 'stop@11.5', 'stop', 'start', 'stop']);
  });

  // Faded out instead, the old copy would end later and take the new one off the board.
  it('re-triggering a fading pad cuts the old copy at once', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('bed.wav'));
    board.setFade(pad.id, true);
    board.play(pad.id);
    board.play(pad.id);
    expect(ctx.started).toEqual(['start', 'stop', 'start']);
    ctx.sources[0]!.onended?.();
    expect(board.isPlaying(pad.id)).toBe(true);
  });

  it('cuts a fading pad at once on close', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('bed.wav'));
    board.setFade(pad.id, true);
    board.play(pad.id);
    board.close();
    expect(ctx.started).toEqual(['start', 'stop']);
  });

  it('stops everything on close', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('a.wav'));
    board.play(pad.id);
    board.close();
    expect(ctx.started).toContain('stop');
    expect(ctx.close).toHaveBeenCalled();
  });
});

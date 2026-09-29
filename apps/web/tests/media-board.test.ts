import { describe, it, expect, vi } from 'vitest';
import { MediaBoard } from '@/lib/media-board';

/**
 * The load-bearing property: the mic and the pads meet in ONE output track,
 * which is what every peer hears and what gets recorded.
 */
function fakeCtx() {
  const destTrack = { kind: 'audio', id: 'mixed' } as MediaStreamTrack;
  const started: string[] = [];
  const sources: { onended: (() => void) | null }[] = [];
  const ctx = {
    started,
    sources,
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [destTrack] } }),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createBufferSource: () => {
      const node = {
        buffer: null as AudioBuffer | null,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        start: () => started.push('start'),
        stop: () => started.push('stop'),
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
    expect(ctx.createMediaStreamSource).toHaveBeenCalled();
  });

  it('exposes a mixed output track distinct from the mic', () => {
    const { board } = mkBoard();
    expect(board.outputTrack?.id).toBe('mixed');
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

  it('stops everything on close', async () => {
    const { board, ctx } = mkBoard();
    const pad = await board.load(file('a.wav'));
    board.play(pad.id);
    board.close();
    expect(ctx.started).toContain('stop');
    expect(ctx.close).toHaveBeenCalled();
  });
});

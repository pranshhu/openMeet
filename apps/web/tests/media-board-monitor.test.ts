import { describe, it, expect, vi, afterEach } from 'vitest';
import { MediaBoard } from '@/lib/media-board';

/**
 * Unlike the fake in media-board.test.ts, every destination node here is its
 * own object, so the mix and what the host hears can be told apart.
 */
function fakeCtx() {
  const dests: { stream: MediaStream }[] = [];
  const gains: { connect: ReturnType<typeof vi.fn> }[] = [];
  const micNode = { connect: vi.fn() };
  return {
    dests,
    gains,
    micNode,
    currentTime: 0,
    destination: { id: 'own output' },
    createMediaStreamDestination: () => {
      const dest = {
        stream: Object.assign(new EventTarget(), {
          id: `dest-${dests.length}`,
          getAudioTracks: () => [],
        }) as unknown as MediaStream,
      };
      dests.push(dest);
      return dest;
    },
    createMediaStreamSource: () => micNode,
    createGain: () => {
      const node = { gain: { value: 1 }, connect: vi.fn() };
      gains.push(node);
      return node;
    },
    createBufferSource: () => ({
      buffer: null as AudioBuffer | null,
      loop: false,
      onended: null as (() => void) | null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
    decodeAudioData: async () => ({ duration: 1 }) as AudioBuffer,
    close: vi.fn(),
  };
}

function mkBoard() {
  const ctx = fakeCtx();
  const mic = Object.assign(new EventTarget(), {
    getAudioTracks: () => [{ kind: 'audio' }],
  }) as unknown as MediaStream;
  const board = new MediaBoard(mic, function () { return ctx as unknown as AudioContext; } as never);
  // The mix is the node the microphone feeds; the other one is what the host hears.
  const mix = ctx.micNode.connect.mock.calls[0]?.[0] as (typeof ctx.dests)[number] | undefined;
  const monitor = ctx.dests.find((d) => d !== mix);
  return { board, ctx, mix, monitor };
}

const file = (name: string) =>
  ({ name, arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as File;
const playedByElement = () =>
  (document.querySelector('audio') as { srcObject?: unknown } | null)?.srcObject;

describe('MediaBoard: what the person who fires a pad hears', () => {
  afterEach(() => {
    document.querySelectorAll('audio').forEach((a) => a.remove());
  });

  it('sends a pad to the mix and to an element, never to the graph’s own output', async () => {
    const { board, ctx, mix, monitor } = mkBoard();
    const pad = await board.load(file('sting.wav'));
    board.play(pad.id);

    const gain = ctx.gains[0]!;
    expect(mix).toBeDefined();
    expect(monitor).toBeDefined();
    expect(gain.connect).toHaveBeenCalledWith(mix);
    expect(gain.connect).toHaveBeenCalledWith(monitor);
    expect(gain.connect).not.toHaveBeenCalledWith(ctx.destination);
    expect(playedByElement()).toBe(monitor?.stream);
  });

  it('keeps the microphone out of what they hear', () => {
    const { ctx, mix, monitor } = mkBoard();
    expect(monitor).toBeDefined();
    expect(ctx.micNode.connect).toHaveBeenCalledTimes(1);
    expect(ctx.micNode.connect).toHaveBeenCalledWith(mix);
  });

  it('takes the element away when the board closes', () => {
    const { board } = mkBoard();
    expect(document.querySelector('audio')).not.toBeNull();
    board.close();
    expect(document.querySelector('audio')).toBeNull();
  });
});

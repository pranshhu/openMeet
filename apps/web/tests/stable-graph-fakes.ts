import { vi } from 'vitest';

/** One fake AudioContext: every node it made, in the order it made them. */
export interface FakeGraphContext {
  dests: { stream: MediaStream; channelCount: number; channelCountMode: string }[];
  sources: {
    stream: MediaStream;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[];
}

/**
 * The globals SwitchableMedia builds its stable stream from. Every destination
 * node is its own object with its own track (`dest-0`, `dest-1`, … in the
 * order made, across contexts) and every source node remembers the stream it
 * reads, so what feeds what can be told apart. Returns the contexts in the
 * order the page made them. Undo with `vi.unstubAllGlobals()`.
 */
export function installStableGraph(): FakeGraphContext[] {
  const contexts: FakeGraphContext[] = [];
  let made = 0;
  vi.stubGlobal(
    'AudioContext',
    vi.fn().mockImplementation(() => {
      const graph: FakeGraphContext = { dests: [], sources: [] };
      contexts.push(graph);
      return {
        state: 'running',
        createMediaStreamDestination: () => {
          const track = {
            kind: 'audio',
            id: `dest-${made++}`,
            enabled: true,
            stop: vi.fn(),
          } as unknown as MediaStreamTrack;
          const dest = { stream: new MediaStream([track]), channelCount: 0, channelCountMode: '' };
          graph.dests.push(dest);
          return dest;
        },
        createMediaStreamSource: (stream: MediaStream) => {
          // A real context refuses a stream that has no audio track.
          if (stream.getAudioTracks().length === 0) throw new Error('no audio track');
          const source = { stream, connect: vi.fn(), disconnect: vi.fn() };
          graph.sources.push(source);
          return source;
        },
        close: vi.fn().mockResolvedValue(undefined),
      };
    })
  );
  vi.stubGlobal(
    'MediaStreamTrackGenerator',
    vi.fn().mockImplementation(() => ({
      kind: 'video',
      id: 'stable-video',
      enabled: true,
      stop: vi.fn(),
      // A generator has these of its own; they know nothing of a camera.
      getConstraints: () => ({}),
      applyConstraints: vi.fn().mockResolvedValue(undefined),
      writable: {
        getWriter: () => ({
          write: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        }),
      },
    }))
  );
  vi.stubGlobal(
    'MediaStreamTrackProcessor',
    vi.fn().mockImplementation(() => ({
      readable: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true }),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      },
    }))
  );
  return contexts;
}

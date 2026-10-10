import type { MediaBoard, Pad } from '@/lib/media-board';

/** Just enough board for the panel: it holds pads and remembers their switches. */
export function fakeBoard(): MediaBoard {
  let pads: Pad[] = [];
  const set = (id: string, change: Partial<Pad>) => {
    pads = pads.map((p) => (p.id === id ? { ...p, ...change } : p));
  };
  return {
    get pads() {
      return pads;
    },
    async load(file: File): Promise<Pad> {
      const pad: Pad = { id: `pad-${pads.length + 1}`, name: file.name, durationMs: 1500 };
      pads = [...pads, pad];
      return pad;
    },
    play: () => {},
    stop: () => {},
    isPlaying: () => false,
    setLoop: (id: string, loop: boolean) => set(id, { loop }),
    setFade: (id: string, fade: boolean) => set(id, { fade }),
    onPadEnded: () => () => {},
  } as unknown as MediaBoard;
}

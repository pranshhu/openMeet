import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { presentSlides, type PresentedSlides } from '@/lib/slides';

const pdf = vi.hoisted(() => ({ openPdf: vi.fn() }));

// isPdf stays real: it is what tells a PDF from a picture here.
vi.mock('@/lib/pdf-slides', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pdf-slides')>()),
  openPdf: pdf.openPdf,
}));

// A picture that loads when the test says so, or at once while `auto` is on.
// Its url comes from the stubbed createObjectURL, so a drawn picture can be
// told by the name of its file.
class MockImage {
  static all: MockImage[] = [];
  static auto = true;
  naturalWidth = 800;
  naturalHeight = 600;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url = '';
  constructor() {
    MockImage.all.push(this);
  }
  set src(v: string) {
    this.url = v;
    if (!MockImage.auto) return;
    void Promise.resolve().then(() => (v.includes('broken') ? this.onerror?.() : this.onload?.()));
  }
}

const png = (name: string) => new File(['bytes'], name, { type: 'image/png' });

describe('presentSlides', () => {
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;
  let originalImage: typeof Image;
  let videoTrack: { kind: string; stop: ReturnType<typeof vi.fn>; contentHint?: string };
  let captureStream: ReturnType<typeof vi.fn>;
  let fillRect: ReturnType<typeof vi.fn>;
  let drawImage: ReturnType<typeof vi.fn>;
  let revoke: ReturnType<typeof vi.fn>;
  let canvasesMade: number;
  let decks: PresentedSlides[];

  const present = async (files: File[]) => {
    const deck = await presentSlides(files);
    decks.push(deck);
    return deck;
  };
  const drawn = () => drawImage.mock.calls.map((c) => (c[0] as MockImage).url);

  beforeEach(() => {
    MockImage.all = [];
    MockImage.auto = true;
    decks = [];
    canvasesMade = 0;
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    originalImage = globalThis.Image;
    globalThis.Image = MockImage as unknown as typeof Image;
    URL.createObjectURL = vi.fn((f: Blob) => `blob:${(f as File).name}`);
    revoke = vi.fn();
    URL.revokeObjectURL = revoke;

    videoTrack = { kind: 'video', stop: vi.fn() };
    captureStream = vi.fn(() => {
      const tracks = [videoTrack];
      return { getTracks: () => tracks, getVideoTracks: () => tracks };
    });
    HTMLCanvasElement.prototype.captureStream = captureStream;
    fillRect = vi.fn();
    drawImage = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => {
      canvasesMade += 1;
      return { fillStyle: '', fillRect, drawImage };
    }) as never;
  });

  afterEach(() => {
    for (const d of decks) d.stop();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    globalThis.Image = originalImage;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the pictures only, in name order with numbers counted as numbers', async () => {
    const deck = await present([png('slide10.png'), png('slide2.png'), new File(['t'], 'notes.txt', { type: 'text/plain' }), png('slide1.png')]);
    expect(deck.count).toBe(3);
    expect(deck.index).toBe(0);
    expect(drawn()).toEqual(['blob:slide1.png']);
    await deck.show(1);
    expect(drawn().at(-1)).toBe('blob:slide2.png');
    await deck.show(2);
    expect(drawn().at(-1)).toBe('blob:slide10.png');
  });

  it('rejects when no file is a picture', async () => {
    await expect(presentSlides([new File(['t'], 'notes.txt', { type: 'text/plain' })])).rejects.toThrow();
  });

  it('draws every slide on one canvas and one stream, and puts no hint on the track', async () => {
    const deck = await present([png('a.png'), png('b.png')]);
    const tracks = deck.stream.getVideoTracks();
    await deck.show(1);
    expect(deck.stream.getVideoTracks()).toEqual(tracks);
    expect(deck.stream.getVideoTracks()[0]).toBe(videoTrack);
    expect(captureStream).toHaveBeenCalledTimes(1);
    expect(captureStream).toHaveBeenCalledWith(30);
    expect(canvasesMade).toBe(1);
    expect(videoTrack.contentHint).toBeUndefined();
  });

  it('changes nothing for an index outside the deck', async () => {
    const deck = await present([png('a.png'), png('b.png'), png('c.png')]);
    const before = drawImage.mock.calls.length;
    await deck.show(5);
    await deck.show(-1);
    await deck.show(1.5);
    expect(deck.index).toBe(0);
    expect(drawImage.mock.calls.length).toBe(before);
    expect(MockImage.all).toHaveLength(1);
  });

  it('draws the slide asked for last when an earlier one arrives late', async () => {
    const deck = await present([png('a.png'), png('b.png'), png('c.png')]);
    MockImage.auto = false;
    const first = deck.show(1);
    expect(deck.index).toBe(1);
    const second = deck.show(2);
    expect(deck.index).toBe(2);
    const [, late, latest] = MockImage.all;
    latest!.onload?.();
    await second;
    late!.onload?.();
    await first;
    expect(drawn().at(-1)).toBe('blob:c.png');
    expect(drawn()).not.toContain('blob:b.png');
    expect(revoke).toHaveBeenCalledWith('blob:b.png');
    expect(revoke).not.toHaveBeenCalledWith('blob:c.png');
  });

  it('shows a picture that cannot be decoded as a black slide', async () => {
    vi.useFakeTimers();
    const deck = await present([png('a.png'), png('broken.png')]);
    const fills = fillRect.mock.calls.length;
    await expect(deck.show(1)).resolves.toBeUndefined();
    expect(deck.index).toBe(1);
    expect(fillRect.mock.calls.length).toBe(fills + 1);
    expect(fillRect).toHaveBeenLastCalledWith(0, 0, 1920, 1080);
    const before = drawImage.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(drawImage.mock.calls.length).toBe(before);
    expect(revoke).toHaveBeenCalledWith('blob:a.png');
    expect(revoke).toHaveBeenCalledWith('blob:broken.png');
  });

  it('repaints the slide on screen on a timer', async () => {
    vi.useFakeTimers();
    await present([png('a.png')]);
    expect(drawImage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(drawImage.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it('lets go of the slide before when the next is shown', async () => {
    const deck = await present([png('a.png'), png('b.png')]);
    expect(revoke).not.toHaveBeenCalled();
    await deck.show(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:a.png');
  });

  it('stop ends the repaint, lets go of the slide and the track, and later shows draw nothing', async () => {
    vi.useFakeTimers();
    const deck = await present([png('a.png'), png('b.png')]);
    deck.stop();
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:a.png');
    const before = drawImage.mock.calls.length;
    const fills = fillRect.mock.calls.length;
    vi.advanceTimersByTime(1000);
    await deck.show(1);
    expect(drawImage.mock.calls.length).toBe(before);
    expect(fillRect.mock.calls.length).toBe(fills);
    expect(MockImage.all).toHaveLength(1);
  });

  it('lets go of a slide that arrives after stop', async () => {
    const deck = await present([png('a.png'), png('b.png')]);
    MockImage.auto = false;
    const pending = deck.show(1);
    deck.stop();
    MockImage.all[1]!.onload?.();
    await pending;
    expect(revoke).toHaveBeenCalledWith('blob:b.png');
    expect(drawn()).toEqual(['blob:a.png']);
  });
});

describe('presentSlides: a PDF', () => {
  const pdfFile = (name = 'deck.pdf') => new File(['%PDF'], name, { type: 'application/pdf' });
  const page = (name: string) => ({ source: { name } as unknown as CanvasImageSource, width: 834, height: 1080, release: vi.fn() });

  let videoTrack: { kind: string; stop: ReturnType<typeof vi.fn> };
  let captureStream: ReturnType<typeof vi.fn>;
  let fillRect: ReturnType<typeof vi.fn>;
  let drawImage: ReturnType<typeof vi.fn>;
  let canvasesMade: number;
  let pages: (ReturnType<typeof page> | null)[];
  let close: ReturnType<typeof vi.fn>;
  let render: ReturnType<typeof vi.fn>;
  let decks: PresentedSlides[];

  const present = async (files: File[] = [pdfFile()]) => {
    const deck = await presentSlides(files);
    decks.push(deck);
    return deck;
  };
  const drawn = () => drawImage.mock.calls.map((c) => (c[0] as { name: string }).name);

  beforeEach(() => {
    decks = [];
    canvasesMade = 0;
    pages = [page('page1'), page('page2'), page('page3')];
    close = vi.fn();
    render = vi.fn(async (i: number) => pages[i] ?? null);
    pdf.openPdf.mockReset();
    pdf.openPdf.mockResolvedValue({ count: 3, render, close });
    videoTrack = { kind: 'video', stop: vi.fn() };
    captureStream = vi.fn(() => {
      const tracks = [videoTrack];
      return { getTracks: () => tracks, getVideoTracks: () => tracks };
    });
    HTMLCanvasElement.prototype.captureStream = captureStream;
    fillRect = vi.fn();
    drawImage = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => {
      canvasesMade += 1;
      return { fillStyle: '', fillRect, drawImage };
    }) as never;
  });

  afterEach(() => {
    for (const d of decks) d.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('presents one PDF as a deck of its pages, the first on screen', async () => {
    const file = pdfFile();
    const deck = await present([file]);
    expect(pdf.openPdf).toHaveBeenCalledWith(file);
    expect(deck.count).toBe(3);
    expect(deck.index).toBe(0);
    expect(drawn()).toEqual(['page1']);
    expect(drawImage.mock.calls[0]!.slice(1)).toEqual([543, 0, 834, 1080]);
  });

  it('takes a PDF by its name when the type is empty', async () => {
    await present([new File(['%PDF'], 'Deck.PDF', { type: '' })]);
    expect(pdf.openPdf).toHaveBeenCalledTimes(1);
  });

  it('shows the next page on the same canvas and stream, and lets go of the page before', async () => {
    const deck = await present();
    const tracks = deck.stream.getVideoTracks();
    expect(pages[0]!.release).not.toHaveBeenCalled();
    await deck.show(1);
    expect(deck.index).toBe(1);
    expect(drawn().at(-1)).toBe('page2');
    expect(pages[0]!.release).toHaveBeenCalledTimes(1);
    expect(pages[1]!.release).not.toHaveBeenCalled();
    expect(deck.stream.getVideoTracks()).toEqual(tracks);
    expect(captureStream).toHaveBeenCalledTimes(1);
    expect(canvasesMade).toBe(1);
  });

  it('paints black for a page that could not be drawn', async () => {
    pages[1] = null;
    const deck = await present();
    const before = drawImage.mock.calls.length;
    await deck.show(1);
    expect(fillRect).toHaveBeenLastCalledWith(0, 0, 1920, 1080);
    expect(drawImage.mock.calls.length).toBe(before);
    expect(pages[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('drops a page that arrives after a later one was asked for, and lets go of it', async () => {
    const deck = await present();
    let arrive!: () => void;
    render.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (arrive = r));
      return pages[1]!;
    });
    const slow = deck.show(1);
    await deck.show(2);
    arrive();
    await slow;
    expect(drawn().at(-1)).toBe('page3');
    expect(drawn()).not.toContain('page2');
    expect(pages[1]!.release).toHaveBeenCalledTimes(1);
    expect(pages[2]!.release).not.toHaveBeenCalled();
  });

  it('changes nothing for an index outside the deck', async () => {
    const deck = await present();
    await deck.show(3);
    await deck.show(-1);
    expect(deck.index).toBe(0);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('repaints the page on screen on a timer', async () => {
    vi.useFakeTimers();
    await present();
    expect(drawImage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(drawImage.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it('stop closes the PDF, lets go of the page and the track, and ends the repaint', async () => {
    vi.useFakeTimers();
    const deck = await present();
    deck.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(pages[0]!.release).toHaveBeenCalledTimes(1);
    expect(videoTrack.stop).toHaveBeenCalled();
    const before = drawImage.mock.calls.length;
    vi.advanceTimersByTime(1000);
    await deck.show(1);
    expect(drawImage.mock.calls.length).toBe(before);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('rejects a PDF chosen with a picture, or with another PDF, and opens nothing', async () => {
    await expect(presentSlides([pdfFile(), new File(['x'], 'a.png', { type: 'image/png' })])).rejects.toThrow();
    await expect(presentSlides([pdfFile('a.pdf'), pdfFile('b.pdf')])).rejects.toThrow();
    expect(pdf.openPdf).not.toHaveBeenCalled();
    expect(captureStream).not.toHaveBeenCalled();
  });

  it('rejects when the PDF cannot be opened, and makes no stream', async () => {
    pdf.openPdf.mockRejectedValue(new Error('password'));
    await expect(presentSlides([pdfFile()])).rejects.toThrow('password');
    expect(captureStream).not.toHaveBeenCalled();
  });
});

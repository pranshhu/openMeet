import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isPdf, openPdf, MAX_PDF_BYTES, MAX_PDF_PAGES, type PdfDeck } from '@/lib/pdf-slides';

const h = vi.hoisted(() => ({
  getDocument: vi.fn(),
  loaded: 0,
  PDFWorker: class {
    constructor(public opts: unknown) {}
  },
}));
const FakePDFWorker = h.PDFWorker;

vi.mock('pdfjs-dist', () => {
  h.loaded += 1;
  return { getDocument: h.getDocument, PDFWorker: h.PDFWorker };
});

class FakeWorker {
  static made: FakeWorker[] = [];
  terminate = vi.fn();
  constructor(
    public url: URL,
    public opts: unknown
  ) {
    FakeWorker.made.push(this);
  }
}

interface FakeRender {
  resolve: () => void;
  reject: (e: unknown) => void;
  cancel: ReturnType<typeof vi.fn>;
}

// A page whose render settles when the test says so; `renders` lists every render it was asked for.
function fakePage(width: number, height: number) {
  const renders: FakeRender[] = [];
  const canvases: HTMLCanvasElement[] = [];
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale }),
    render: vi.fn(({ canvas }: { canvas: HTMLCanvasElement; viewport: { width: number; height: number } }) => {
      canvases.push(canvas);
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const entry: FakeRender = { resolve, reject, cancel: vi.fn(() => reject(new Error('cancelled'))) };
      renders.push(entry);
      return { promise, cancel: entry.cancel };
    }),
    cleanup: vi.fn(),
  };
  return { page, renders, canvases };
}

type Fake = ReturnType<typeof fakePage>;

function fakeTask(numPages: number, pages: Fake[] = []) {
  const doc = { numPages, getPage: vi.fn(async (n: number) => pages[n - 1]?.page) };
  return { doc, promise: Promise.resolve(doc), destroy: vi.fn(async () => {}) };
}

const pdfFile = (name = 'deck.pdf') => {
  const file = new File(['%PDF'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) });
  return file;
};

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('isPdf', () => {
  it('says yes for the type or a .pdf name in any case, and no for a picture', () => {
    expect(isPdf(new File(['x'], 'a', { type: 'application/pdf' }))).toBe(true);
    expect(isPdf(new File(['x'], 'deck.PDF', { type: '' }))).toBe(true);
    expect(isPdf(new File(['x'], 'deck.png', { type: 'image/png' }))).toBe(false);
    expect(isPdf(new File(['x'], 'deck.pdf.png', { type: '' }))).toBe(false);
  });
});

describe('openPdf', () => {
  let decks: PdfDeck[];

  // Runs first: the library is fetched when a PDF is presented, not when the module is.
  it('loads PDF.js only when a PDF is opened', async () => {
    expect(h.loaded).toBe(0);
    h.getDocument.mockReturnValue(fakeTask(1));
    decks.push(await openPdf(pdfFile()));
    expect(h.loaded).toBe(1);
  });

  const open = async (task: ReturnType<typeof fakeTask>, file = pdfFile()) => {
    h.getDocument.mockReturnValue(task);
    const deck = await openPdf(file);
    decks.push(deck);
    return deck;
  };

  beforeEach(() => {
    decks = [];
    FakeWorker.made = [];
    h.getDocument.mockReset();
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    for (const d of decks) d.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects a file over the size limit without reading it or making a worker', async () => {
    const file = pdfFile();
    Object.defineProperty(file, 'size', { value: MAX_PDF_BYTES + 1 });
    await expect(openPdf(file)).rejects.toThrow();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(FakeWorker.made).toHaveLength(0);
    expect(h.getDocument).not.toHaveBeenCalled();
  });

  it('opens the bytes in a worker of its own, with code evaluation off and nothing to fetch', async () => {
    await open(fakeTask(1));
    expect(FakeWorker.made).toHaveLength(1);
    const worker = FakeWorker.made[0]!;
    // The test bundler may append a query to a worker url; the file name is what counts.
    expect(String(worker.url)).toMatch(/pdf\.worker\.min\.mjs(\?|$)/);
    expect(worker.opts).toEqual({ type: 'module' });
    const params = h.getDocument.mock.calls[0]![0];
    expect(Object.keys(params).sort()).toEqual(['data', 'isEvalSupported', 'maxImageSize', 'worker']);
    expect(params.isEvalSupported).toBe(false);
    expect(params.maxImageSize).toBe(50_000_000);
    expect(Array.from(params.data as Uint8Array)).toEqual([1, 2, 3]);
    expect(params.worker).toBeInstanceOf(FakePDFWorker);
    expect((params.worker as InstanceType<typeof FakePDFWorker>).opts).toEqual({ port: worker });
  });

  it('rejects a document that cannot be loaded and ends the worker', async () => {
    const task = { promise: Promise.reject(new Error('password')), destroy: vi.fn(async () => {}) };
    h.getDocument.mockReturnValue(task);
    await expect(openPdf(pdfFile())).rejects.toThrow('Could not open this PDF.');
    expect(FakeWorker.made[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('gives up after 15 seconds, destroying the loading task and ending the worker', async () => {
    vi.useFakeTimers();
    const task = { promise: new Promise(() => {}), destroy: vi.fn(async () => {}) };
    h.getDocument.mockReturnValue(task);
    const opened = openPdf(pdfFile());
    const outcome = opened.then(
      () => 'opened',
      () => 'rejected'
    );
    await flush();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(task.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe('rejected');
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(FakeWorker.made[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects a document with no page and ends the worker', async () => {
    h.getDocument.mockReturnValue(fakeTask(0));
    await expect(openPdf(pdfFile())).rejects.toThrow();
    expect(FakeWorker.made[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('counts the pages, and no more than the limit', async () => {
    expect((await open(fakeTask(5))).count).toBe(5);
    expect(MAX_PDF_PAGES).toBe(1000);
    expect((await open(fakeTask(5000))).count).toBe(1000);
  });

  describe('render', () => {
    it('fits a page into 1920 x 1080 with its own shape', async () => {
      const portrait = fakePage(612, 792);
      const wide = fakePage(4000, 1000);
      const deck = await open(fakeTask(2, [portrait, wide]));
      const first = deck.render(0);
      await flush();
      portrait.renders[0]!.resolve();
      const slide = await first;
      expect(slide).toMatchObject({ width: 834, height: 1080 });
      expect(slide!.source).toBe(portrait.canvases[0]);
      expect(portrait.canvases[0]).toMatchObject({ width: 834, height: 1080 });
      const { viewport } = portrait.page.render.mock.calls[0]![0];
      expect(viewport.width).toBeCloseTo(834.5, 0);
      expect(viewport.height).toBeCloseTo(1080, 0);
      const second = deck.render(1);
      await flush();
      wide.renders[0]!.resolve();
      await expect(second).resolves.toMatchObject({ width: 1920, height: 480 });
      expect(wide.canvases[0]).toMatchObject({ width: 1920, height: 480 });
    });

    it('is at least one pixel wide and high', async () => {
      const thin = fakePage(1, 100000);
      const flat = fakePage(3840, 1);
      const deck = await open(fakeTask(2, [thin, flat]));
      const tall = deck.render(0);
      await flush();
      thin.renders[0]!.resolve();
      await expect(tall).resolves.toMatchObject({ width: 1, height: 1080 });
      const wide = deck.render(1);
      await flush();
      flat.renders[0]!.resolve();
      await expect(wide).resolves.toMatchObject({ width: 1920, height: 1 });
    });

    it('resolves null for a page without a usable size, and draws nothing', async () => {
      for (const [w, h2] of [
        [0, 792],
        [612, 0],
        [Number.NaN, 792],
        [612, Infinity],
        [-5, 792],
      ] as const) {
        const bad = fakePage(w, h2);
        const deck = await open(fakeTask(1, [bad]));
        await expect(deck.render(0)).resolves.toBeNull();
        expect(bad.page.render).not.toHaveBeenCalled();
        expect(bad.page.cleanup).toHaveBeenCalled();
      }
    });

    it('resolves null for an index outside the deck without asking the document for a page', async () => {
      const task = fakeTask(5000, [fakePage(100, 100)]);
      task.doc.getPage = vi.fn(async () => fakePage(100, 100).page);
      const deck = await open(task);
      for (const index of [1000, -1, 0.5, Number.NaN]) {
        await expect(deck.render(index)).resolves.toBeNull();
      }
      expect(task.doc.getPage).not.toHaveBeenCalled();
    });

    it('cancels the render in flight when a newer one is asked for', async () => {
      const a = fakePage(100, 100);
      const b = fakePage(100, 100);
      const deck = await open(fakeTask(2, [a, b]));
      const first = deck.render(0);
      await flush();
      const second = deck.render(1);
      await expect(first).resolves.toBeNull();
      expect(a.renders[0]!.cancel).toHaveBeenCalledTimes(1);
      expect(a.canvases[0]).toMatchObject({ width: 0, height: 0 });
      await flush();
      b.renders[0]!.resolve();
      await expect(second).resolves.not.toBeNull();
      expect(b.renders[0]!.cancel).not.toHaveBeenCalled();
    });

    it('starts no render for a page that arrives just as a newer render was asked for', async () => {
      const a = fakePage(100, 100);
      const b = fakePage(100, 100);
      const task = fakeTask(2, [a, b]);
      let second!: ReturnType<PdfDeck['render']>;
      let deck!: PdfDeck;
      task.doc.getPage = vi.fn((n: number) => {
        const arrived = Promise.resolve(n === 1 ? a.page : b.page);
        // Runs before the render that asked for the page goes on with it.
        if (n === 1) void arrived.then(() => (second = deck.render(1)));
        return arrived;
      });
      deck = await open(task);
      await expect(deck.render(0)).resolves.toBeNull();
      expect(a.page.render).not.toHaveBeenCalled();
      await flush();
      b.renders[0]!.resolve();
      await expect(second).resolves.not.toBeNull();
    });

    it('resolves null when the page does not arrive in 10 seconds, and the next render still works', async () => {
      vi.useFakeTimers();
      const stuck = fakePage(100, 100);
      const ok = fakePage(100, 100);
      const task = fakeTask(2, [stuck, ok]);
      task.doc.getPage = vi.fn((n: number) => (n === 1 ? new Promise<never>(() => {}) : Promise.resolve(ok.page)));
      const deck = await open(task);
      const first = deck.render(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(first).resolves.toBeNull();
      const second = deck.render(1);
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      ok.renders[0]!.resolve();
      await expect(second).resolves.not.toBeNull();
    });

    it('resolves null for a render that finished just as a newer one was asked for', async () => {
      const a = fakePage(100, 100);
      const b = fakePage(100, 100);
      const deck = await open(fakeTask(2, [a, b]));
      const first = deck.render(0);
      await flush();
      a.renders[0]!.resolve();
      const second = deck.render(1);
      await expect(first).resolves.toBeNull();
      expect(a.canvases[0]).toMatchObject({ width: 0, height: 0 });
      expect(a.page.cleanup).toHaveBeenCalled();
      await flush();
      b.renders[0]!.resolve();
      await expect(second).resolves.not.toBeNull();
    });

    it('leaves no timer running once a render is over', async () => {
      vi.useFakeTimers();
      const p = fakePage(100, 100);
      const deck = await open(fakeTask(1, [p]));
      const shown = deck.render(0);
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      p.renders[0]!.resolve();
      await shown;
      expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves null when the render fails', async () => {
      const p = fakePage(100, 100);
      const deck = await open(fakeTask(1, [p]));
      const shown = deck.render(0);
      await flush();
      p.renders[0]!.reject(new Error('bad page'));
      await expect(shown).resolves.toBeNull();
      expect(p.page.cleanup).toHaveBeenCalled();
    });

    it('resolves null when the page cannot be read', async () => {
      const task = fakeTask(1);
      task.doc.getPage = vi.fn(async () => {
        throw new Error('broken page');
      });
      const deck = await open(task);
      await expect(deck.render(0)).resolves.toBeNull();
    });

    it('release frees the page canvas and the page', async () => {
      const p = fakePage(100, 100);
      const deck = await open(fakeTask(1, [p]));
      const shown = deck.render(0);
      await flush();
      p.renders[0]!.resolve();
      const slide = (await shown)!;
      expect(p.page.cleanup).not.toHaveBeenCalled();
      expect(p.canvases[0]!.width).toBeGreaterThan(0);
      slide.release();
      expect(p.page.cleanup).toHaveBeenCalledTimes(1);
      expect(p.canvases[0]).toMatchObject({ width: 0, height: 0 });
    });
  });

  it('leaves no timer running once it has opened', async () => {
    vi.useFakeTimers();
    h.getDocument.mockReturnValue(fakeTask(1));
    decks.push(await openPdf(pdfFile()));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close cancels the render in flight, destroys the document and ends the worker', async () => {
    const p = fakePage(100, 100);
    const task = fakeTask(1, [p]);
    const deck = await open(task);
    const shown = deck.render(0);
    await flush();
    deck.close();
    await expect(shown).resolves.toBeNull();
    expect(p.renders[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(FakeWorker.made[0]!.terminate).toHaveBeenCalledTimes(1);
    await expect(deck.render(0)).resolves.toBeNull();
  });

  it('close does its work once, and cancels nothing that has finished', async () => {
    const p = fakePage(100, 100);
    const task = fakeTask(1, [p]);
    const deck = await open(task);
    const shown = deck.render(0);
    await flush();
    p.renders[0]!.resolve();
    await shown;
    deck.close();
    deck.close();
    expect(p.renders[0]!.cancel).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(FakeWorker.made[0]!.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('openPdf: what the presenter reads when it rejects', () => {
  beforeEach(() => {
    FakeWorker.made = [];
    h.getDocument.mockReset();
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const opening = (reason: unknown) => {
    h.getDocument.mockReturnValue({ promise: Promise.reject(reason), destroy: vi.fn(async () => {}) });
    return openPdf(pdfFile());
  };

  it('says a file over the size limit is too big', async () => {
    const file = pdfFile();
    Object.defineProperty(file, 'size', { value: MAX_PDF_BYTES + 1 });
    await expect(openPdf(file)).rejects.toThrow(new Error('This PDF is over 100 MB.'));
  });

  it('says a PDF with a password cannot be presented, and what to do', async () => {
    await expect(opening({ name: 'PasswordException' })).rejects.toThrow(
      new Error('This PDF has a password. Save a copy without one and present that.')
    );
  });

  it('says any other failure to open is a file that does not open', async () => {
    await expect(opening(new Error('Invalid PDF structure'))).rejects.toThrow(new Error('Could not open this PDF.'));
  });

  it('says a PDF with no page does not open', async () => {
    h.getDocument.mockReturnValue(fakeTask(0));
    await expect(openPdf(pdfFile())).rejects.toThrow(new Error('Could not open this PDF.'));
  });

  it('says a PDF that takes 15 seconds to open does not open', async () => {
    vi.useFakeTimers();
    try {
      h.getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy: vi.fn(async () => {}) });
      const outcome = openPdf(pdfFile()).catch((e: Error) => e.message);
      await flush();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(outcome).resolves.toBe('Could not open this PDF.');
    } finally {
      vi.useRealTimers();
    }
  });
});

// PDF.js is a chunk fetched on first use: the tab can have outlived a deploy, or
// the network can be down, and then the import itself fails or never answers.
describe('openPdf: when PDF.js cannot be fetched', () => {
  const WONT_OPEN = 'Could not open this PDF.';

  beforeEach(() => {
    FakeWorker.made = [];
    h.getDocument.mockReset();
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('says the file does not open when the import fails, and makes no worker', async () => {
    vi.doMock('pdfjs-dist', () => {
      throw new Error('Failed to fetch dynamically imported module: /_next/static/chunks/pdf.js');
    });
    const { openPdf: open } = await import('@/lib/pdf-slides');
    await expect(open(pdfFile())).rejects.toThrow(new Error(WONT_OPEN));
    expect(FakeWorker.made).toHaveLength(0);
  });

  it('says the file does not open when the import has not answered after 15 seconds', async () => {
    vi.doMock('pdfjs-dist', () => new Promise(() => {}));
    const { openPdf: open } = await import('@/lib/pdf-slides');
    vi.useFakeTimers();
    const outcome = open(pdfFile()).then(
      () => 'opened',
      (e: Error) => e.message
    );
    await flush();
    await vi.advanceTimersByTimeAsync(14_999);
    await expect(Promise.race([outcome, Promise.resolve('waiting')])).resolves.toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe(WONT_OPEN);
  });

  it('says the file does not open when the worker cannot be made', async () => {
    vi.doMock('pdfjs-dist', () => ({ getDocument: h.getDocument, PDFWorker: h.PDFWorker }));
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('SecurityError');
        }
      }
    );
    const { openPdf: open } = await import('@/lib/pdf-slides');
    await expect(open(pdfFile())).rejects.toThrow(new Error(WONT_OPEN));
    expect(h.getDocument).not.toHaveBeenCalled();
  });

  it('makes no worker when the import answers after the 15 seconds', async () => {
    let arrive!: (m: object) => void;
    vi.doMock('pdfjs-dist', () => new Promise<object>((resolve) => (arrive = resolve)));
    const { openPdf: open } = await import('@/lib/pdf-slides');
    vi.useFakeTimers();
    const outcome = open(pdfFile()).catch((e: Error) => e.message);
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(outcome).resolves.toBe(WONT_OPEN);
    arrive({ getDocument: h.getDocument, PDFWorker: h.PDFWorker });
    await flush();
    expect(FakeWorker.made).toHaveLength(0);
    expect(h.getDocument).not.toHaveBeenCalled();
  });

  it('starts no document when the file is read after the 15 seconds, and ends the worker', async () => {
    vi.doMock('pdfjs-dist', () => ({ getDocument: h.getDocument, PDFWorker: h.PDFWorker }));
    const { openPdf: open } = await import('@/lib/pdf-slides');
    let read!: (b: ArrayBuffer) => void;
    const file = new File(['%PDF'], 'deck.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>((r) => (read = r)) });
    vi.useFakeTimers();
    const outcome = open(file).catch((e: Error) => e.message);
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(outcome).resolves.toBe(WONT_OPEN);
    read(new Uint8Array([1]).buffer);
    await flush();
    expect(h.getDocument).not.toHaveBeenCalled();
    expect(FakeWorker.made[0]!.terminate).toHaveBeenCalledTimes(1);
  });
});

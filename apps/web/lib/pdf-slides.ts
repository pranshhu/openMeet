import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from './screen';

// A PDF is a file the presenter downloaded: untrusted content. These bounds keep
// a hostile or oversized one from taking the tab.
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGES = 1000;
// What the presenter reads when a PDF cannot be presented.
const TOO_BIG = 'This PDF is over 100 MB.';
const HAS_PASSWORD = 'This PDF has a password. Save a copy without one and present that.';
const WONT_OPEN = 'Could not open this PDF.';
const MAX_IMAGE_PIXELS = 50_000_000;
const OPEN_MS = 15_000;
const RENDER_MS = 10_000;

export interface PdfPage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

export interface PdfDeck {
  count: number;
  /** The page drawn to fit 1920 x 1080, or null. Never rejects. */
  render(index: number): Promise<PdfPage | null>;
  close(): void;
}

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

// Cleaning up must never throw into the caller: the work it undoes is already over.
const quietly = (undo: () => unknown) => {
  try {
    void Promise.resolve(undo()).catch(() => {});
  } catch {
    /* already gone */
  }
};

const usable = (n: number) => Number.isFinite(n) && n > 0;

/**
 * Open a PDF in the presenter's tab. PDF.js is fetched the first time this runs,
 * and reads the file in a worker of its own, served from this site: it fetches
 * no font, color profile or script, and evaluates nothing as code.
 */
export async function openPdf(file: File): Promise<PdfDeck> {
  if (file.size > MAX_PDF_BYTES) throw new Error(TOO_BIG);
  const pdfjs = await import('pdfjs-dist');
  const worker = new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), {
    type: 'module',
  });
  let task: ReturnType<typeof pdfjs.getDocument> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let count = 0;
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    // This PDF.js has no code evaluation to switch off and ignores the option, which is
    // kept so a version that adds one stays off. Its types declare `port` as null
    // although it takes the Worker.
    const params = {
      data,
      worker: new pdfjs.PDFWorker({ port: worker as unknown as null }),
      isEvalSupported: false,
      maxImageSize: MAX_IMAGE_PIXELS,
    };
    const loading = pdfjs.getDocument(params);
    task = loading;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PDF took too long to open')), OPEN_MS);
    });
    doc = await Promise.race([loading.promise, late]);
    if (!(doc.numPages > 0)) throw new Error('PDF has no page');
    count = Math.min(doc.numPages, MAX_PDF_PAGES);
  } catch (e) {
    if (task) quietly(() => task!.destroy());
    worker.terminate();
    throw new Error((e as { name?: unknown } | null)?.name === 'PasswordException' ? HAS_PASSWORD : WONT_OPEN);
  } finally {
    clearTimeout(timer);
  }

  let closed = false;
  let cancelInFlight: (() => void) | null = null;

  const render = async (index: number): Promise<PdfPage | null> => {
    cancelInFlight?.();
    cancelInFlight = null;
    if (closed || !Number.isInteger(index) || index < 0 || index >= count) return null;

    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let reject!: (e: Error) => void;
    // Rejects when this render is cancelled, so a render that ignores `cancel` still ends.
    const aborted = new Promise<never>((_, r) => (reject = r));
    aborted.catch(() => {});
    const mine = () => {
      cancelled = true;
      renderTask?.cancel();
      reject(new Error('render cancelled'));
    };
    cancelInFlight = mine;
    const timeout = setTimeout(mine, RENDER_MS);

    let page: PDFPageProxy | undefined;
    let canvas: HTMLCanvasElement | undefined;
    const free = () => {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (page) quietly(() => page!.cleanup());
    };
    try {
      page = await Promise.race([doc.getPage(index + 1), aborted]);
      // A newer render can be asked for between the page arriving and this line.
      if (cancelled) throw new Error('render cancelled');
      const base = page.getViewport({ scale: 1 });
      if (!usable(base.width) || !usable(base.height)) throw new Error('page has no size');
      const scale = Math.min(CANVAS_WIDTH / base.width, CANVAS_HEIGHT / base.height);
      const width = Math.max(1, Math.floor(base.width * scale));
      const height = Math.max(1, Math.floor(base.height * scale));
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      renderTask = page.render({ canvas, viewport: page.getViewport({ scale }) });
      await Promise.race([renderTask.promise, aborted]);
      if (cancelled) throw new Error('render cancelled');
      const shown = page;
      const drawn = canvas;
      return {
        source: drawn,
        width,
        height,
        release: () => {
          drawn.width = 0;
          drawn.height = 0;
          quietly(() => shown.cleanup());
        },
      };
    } catch {
      free();
      return null;
    } finally {
      clearTimeout(timeout);
      if (cancelInFlight === mine) cancelInFlight = null;
    }
  };

  return {
    count,
    render,
    close: () => {
      if (closed) return;
      closed = true;
      cancelInFlight?.();
      cancelInFlight = null;
      quietly(() => task!.destroy());
      worker.terminate();
    },
  };
}

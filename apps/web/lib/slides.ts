import { isPdf, openPdf } from './pdf-slides';
import { CANVAS_HEIGHT, CANVAS_WIDTH, drawLetterboxed } from './screen';

// What the presenter reads when the choice has nothing to present.
const WRONG_CHOICE = 'Pick one PDF, or one or more pictures.';

// The same rate presentFile repaints a photo at: it keeps the captured stream
// giving frames while the picture does not change.
const REPAINT_MS = 200;

export interface PresentedSlides {
  stream: MediaStream;
  stop: () => void;
  /** How many slides the deck has. */
  count: number;
  /** The slide that was asked for last, counted from 0. */
  readonly index: number;
  /** Show one slide. An index outside the deck changes nothing. */
  show: (index: number) => Promise<void>;
}

interface Slide {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/** Null when the file cannot be decoded. Never rejects. */
function decode(file: File): Promise<Slide | null> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  const release = () => URL.revokeObjectURL(url);
  return new Promise((resolve) => {
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, release });
    img.onerror = () => {
      release();
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Present pictures, or one PDF, as a deck of slides, one at a time. One canvas
 * and one captured stream serve the whole deck: a screen recording that is
 * running cannot change tracks, so `show` redraws the canvas instead. Only the
 * slide on screen is held decoded.
 */
export async function presentSlides(files: File[]): Promise<PresentedSlides> {
  let count: number;
  let load: (i: number) => Promise<Slide | null>;
  let closeDeck: (() => void) | undefined;
  if (files.some(isPdf)) {
    // Pages are read by one PDF; mixing it with other files has no order to follow.
    if (files.length !== 1) throw new Error(WRONG_CHOICE);
    const pdf = await openPdf(files[0]!);
    count = pdf.count;
    load = pdf.render;
    closeDeck = pdf.close;
  } else {
    const deck = files
      .filter((f) => f.type.startsWith('image/'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (deck.length === 0) throw new Error(WRONG_CHOICE);
    count = deck.length;
    load = (i) => decode(deck[i]!);
  }

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');

  // Null shows black: before the first slide arrives and for one that cannot be decoded.
  let shown: Slide | null = null;
  let index = 0;
  let asked = 0;
  let stopped = false;

  const paint = () => {
    if (!ctx) return;
    if (shown) {
      drawLetterboxed(ctx, shown.source, shown.width, shown.height);
    } else {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
  };

  const show = async (i: number) => {
    if (stopped || !Number.isInteger(i) || i < 0 || i >= count) return;
    index = i;
    const ticket = ++asked;
    const next = await load(i);
    // A later request, or the end of the deck, got here first: this one is stale.
    if (stopped || ticket !== asked) {
      next?.release();
      return;
    }
    shown?.release();
    shown = next;
    paint();
  };

  const stream: MediaStream =
    typeof (canvas as any).captureStream === 'function'
      ? (canvas as any).captureStream(30)
      : new MediaStream();
  const timer = setInterval(paint, REPAINT_MS);
  await show(0);

  return {
    stream,
    count,
    get index() {
      return index;
    },
    show,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      shown?.release();
      shown = null;
      closeDeck?.();
      stream.getTracks().forEach((t) => t.stop?.());
    },
  };
}

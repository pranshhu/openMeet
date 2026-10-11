'use client';

import { useEffect, useState } from 'react';

/**
 * How long the first frame may take. The browser grants the window only within
 * a few seconds of the click that asked for it, so waiting longer cannot work.
 */
const FIRST_FRAME_MS = 3000;

/** True where the browser can float a video in a window of its own. */
export function canPopOut(): boolean {
  return typeof document !== 'undefined' && document.pictureInPictureEnabled === true;
}

/**
 * Floats `stream`'s picture in the browser's always-on-top window, for a person
 * to put just under their webcam: looking at it is then looking at the lens.
 * Returns the function that closes it. `onEnd` runs when it ends any other way:
 * closed from the window itself (`failed` false), or never opened (true): the
 * browser refused it, or no picture came.
 *
 * The window shows a muted element of its own, never the tile's. The tile keeps
 * playing the sound, so the chosen speaker and the tile's volume apply as
 * before, nothing in the window can pause a voice, and the window outlives a
 * change of layout, which draws new tiles.
 */
export function popOut(stream: MediaStream, onEnd: (failed: boolean) => void): () => void {
  const el = document.createElement('video');
  el.muted = true;
  el.srcObject = stream;
  let done = false;
  let shown = false;
  /** False when it had already ended. */
  const stop = (): boolean => {
    if (done) return false;
    done = true;
    clearTimeout(waiting);
    if (shown) void document.exitPictureInPicture().catch(() => {});
    el.srcObject = null;
    return true;
  };
  const end = (failed: boolean) => {
    if (stop()) onEnd(failed);
  };
  // A camera that delivers nothing never loads, so the browser is never asked.
  const waiting = setTimeout(() => end(true), FIRST_FRAME_MS);
  // The browser takes the request only once the first frame has come.
  el.addEventListener(
    'loadedmetadata',
    () => {
      clearTimeout(waiting);
      void el.requestPictureInPicture().then(
        () => {
          shown = true;
          // Granted after it was closed: hand the window back.
          if (done) void document.exitPictureInPicture().catch(() => {});
        },
        () => end(true)
      );
    },
    { once: true }
  );
  el.addEventListener('leavepictureinpicture', () => {
    shown = false;
    end(false);
  });
  void el.play().catch(() => {});
  return () => void stop();
}

/**
 * Which of `streams` is popped out (or null), and the function that pops one
 * out or, with null, closes the window. Call it from a click: the browser
 * grants the window only then. The window closes by itself once its stream is
 * not among `streams` any more: that person left, their connection was rebuilt,
 * or the caller stopped listing it. `onFail` runs when the window never opened.
 */
export function usePopOut(
  streams: readonly (MediaStream | null)[],
  onFail: () => void
): [MediaStream | null, (stream: MediaStream | null) => void] {
  const [popped, setPopped] = useState<MediaStream | null>(null);
  const live = popped !== null && streams.includes(popped);
  useEffect(() => {
    if (!popped) return;
    if (!live) {
      setPopped(null);
      return;
    }
    // onFail is read when it is called, not a dependency: it only reports.
    return popOut(popped, (failed) => {
      setPopped(null);
      if (failed) onFail();
    });
  }, [popped, live]);
  return [popped, setPopped];
}

'use client';

import { useEffect, useState } from 'react';

/** True where the browser can float a video in a window of its own. */
export function canPopOut(): boolean {
  return typeof document !== 'undefined' && document.pictureInPictureEnabled === true;
}

/**
 * Floats `stream`'s picture in the browser's always-on-top window, for a person
 * to put just under their webcam: looking at it is then looking at the lens.
 * Returns the function that closes it. `onEnd` runs when it ends any other way:
 * closed from the window itself (`failed` false), or refused by the browser
 * (true).
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
    if (shown) void document.exitPictureInPicture().catch(() => {});
    el.srcObject = null;
    return true;
  };
  const end = (failed: boolean) => {
    if (stop()) onEnd(failed);
  };
  // The browser takes the request only once the first frame has come.
  el.addEventListener(
    'loadedmetadata',
    () => {
      void el.requestPictureInPicture().then(
        () => {
          shown = true;
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
 * The stream that is popped out (or null), and the function that pops one out
 * or, with null, closes the window. Call it from a click: the browser grants
 * the window only then. `onFail` runs when the browser refused the window.
 */
export function usePopOut(onFail: () => void): [MediaStream | null, (stream: MediaStream | null) => void] {
  const [popped, setPopped] = useState<MediaStream | null>(null);
  useEffect(() => {
    if (!popped) return;
    // onFail is read when it is called, not a dependency: it only reports.
    return popOut(popped, (failed) => {
      setPopped(null);
      if (failed) onFail();
    });
  }, [popped]);
  return [popped, setPopped];
}

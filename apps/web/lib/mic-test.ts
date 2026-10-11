/** How long the microphone test listens before the clip is played back. */
export const MIC_TEST_MS = 5000;

/**
 * Records `ms` of one microphone track and resolves with the clip, in whatever
 * audio format this browser's recorder picks by default: the clip is only ever
 * played back in the same browser. Aborting `signal` ends the recording early,
 * so no recorder outlives the page that started it.
 */
export function recordMicSample(track: MediaStreamTrack, ms: number, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const recorder = new MediaRecorder(new MediaStream([track]));
    const parts: Blob[] = [];
    const stop = () => {
      if (recorder.state !== 'inactive') recorder.stop();
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) parts.push(e.data);
    };
    recorder.onerror = () => reject(new Error('The microphone test could not record.'));
    recorder.onstop = () => resolve(new Blob(parts, { type: recorder.mimeType }));
    recorder.start();
    const timer = setTimeout(stop, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        stop();
      },
      { once: true }
    );
  });
}

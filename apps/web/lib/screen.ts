export function isScreenShareSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function'
  );
}

export function getScreenStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
}

export async function presentRearCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });
}

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

function drawLetterboxed(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number
) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  if (srcWidth <= 0 || srcHeight <= 0) return;
  const scale = Math.min(CANVAS_WIDTH / srcWidth, CANVAS_HEIGHT / srcHeight);
  const destWidth = srcWidth * scale;
  const destHeight = srcHeight * scale;
  const destX = (CANVAS_WIDTH - destWidth) / 2;
  const destY = (CANVAS_HEIGHT - destHeight) / 2;
  ctx.drawImage(source, destX, destY, destWidth, destHeight);
}

export interface PresentedFile {
  stream: MediaStream;
  stop: () => void;
}

/**
 * Present a photo or a video file as a stream. `monitor` also plays a video's
 * sound on this device, for a presenter who has to hear the clip to talk over it.
 */
export async function presentFile(file: File, monitor = false): Promise<PresentedFile> {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name);

  if (isImage) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;

    await new Promise<void>((resolve, reject) => {
      if (img.complete && img.naturalWidth) {
        resolve();
        return;
      }
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image'));
    });

    const srcW = img.naturalWidth || img.width || CANVAS_WIDTH;
    const srcH = img.naturalHeight || img.height || CANVAS_HEIGHT;
    if (ctx) {
      drawLetterboxed(ctx, img, srcW, srcH);
    }

    const intervalId = setInterval(() => {
      if (ctx) {
        drawLetterboxed(ctx, img, srcW, srcH);
      }
    }, 200);

    const stream: MediaStream =
      typeof (canvas as any).captureStream === 'function'
        ? (canvas as any).captureStream(30)
        : new MediaStream();

    const stop = () => {
      clearInterval(intervalId);
      URL.revokeObjectURL(url);
      stream.getTracks().forEach((t) => t.stop?.());
    };

    return { stream, stop };
  }

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.loop = true;
  video.playsInline = true;
  video.autoplay = true;

  // Extract sound via Web Audio API: createMediaElementSource -> createMediaStreamDestination.
  // The element's own output is taken over by the graph, so the video is silent on this device
  // unless `monitor` also connects it to audioCtx.destination; its audio track is sent to the
  // presented stream either way.
  let audioCtx: AudioContext | null = null;
  let audioTrack: MediaStreamTrack | null = null;
  try {
    const AudioCtxClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtxClass) {
      audioCtx = new AudioCtxClass();
      const source = audioCtx.createMediaElementSource(video);
      const dest = audioCtx.createMediaStreamDestination();
      source.connect(dest);
      if (monitor) source.connect(audioCtx.destination);
      const track = dest.stream.getAudioTracks()[0];
      if (track) {
        audioTrack = track;
      }
    }
  } catch {
    // Video may lack audio or Web Audio not available
  }

  if (!audioTrack) {
    video.muted = true;
  }

  await new Promise<void>((resolve) => {
    if (video.readyState >= 2 && video.videoWidth > 0) {
      resolve();
      return;
    }
    const onReady = () => {
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('canplay', onReady);
      resolve();
    };
    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('canplay', onReady);
    setTimeout(resolve, 500);
  });

  try {
    await video.play();
  } catch {
    video.muted = true;
    await video.play().catch(() => {});
  }

  if (ctx) {
    const srcW = video.videoWidth || CANVAS_WIDTH;
    const srcH = video.videoHeight || CANVAS_HEIGHT;
    drawLetterboxed(ctx, video, srcW, srcH);
  }

  const stream: MediaStream =
    typeof (canvas as any).captureStream === 'function'
      ? (canvas as any).captureStream(30)
      : new MediaStream();

  // A video is motion, not text: marked here, it is sent to the call at its own
  // frame rate instead of at the few frames a second a shared screen gets.
  const frames = stream.getVideoTracks?.()[0];
  if (frames) frames.contentHint = 'motion';

  if (audioTrack) {
    stream.addTrack(audioTrack);
  }

  let rvfcId: number | null = null;
  let rafId: number | null = null;
  let stopped = false;

  const renderFrame = () => {
    if (stopped) return;
    if (ctx) {
      const srcW = video.videoWidth || CANVAS_WIDTH;
      const srcH = video.videoHeight || CANVAS_HEIGHT;
      drawLetterboxed(ctx, video, srcW, srcH);
    }
    if (typeof (video as any).requestVideoFrameCallback === 'function') {
      rvfcId = (video as any).requestVideoFrameCallback(renderFrame);
    } else if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(renderFrame);
    }
  };

  if (typeof (video as any).requestVideoFrameCallback === 'function') {
    rvfcId = (video as any).requestVideoFrameCallback(renderFrame);
  } else if (typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(renderFrame);
  }

  const stop = () => {
    stopped = true;
    if (rvfcId !== null && typeof (video as any).cancelVideoFrameCallback === 'function') {
      (video as any).cancelVideoFrameCallback(rvfcId);
      rvfcId = null;
    }
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    video.pause();
    video.removeAttribute('src');
    try {
      video.load();
    } catch {}
    URL.revokeObjectURL(url);
    if (audioCtx && audioCtx.state !== 'closed') {
      void audioCtx.close().catch(() => {});
    }
    stream.getTracks().forEach((t) => t.stop?.());
  };

  return { stream, stop };
}

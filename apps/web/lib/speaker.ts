/**
 * Which output device plays the call: one choice per browser, kept in
 * localStorage. '' is the system default.
 *
 * The browser plays nothing through a device that has gone away and does not
 * move the sound by itself, so a chosen speaker that is not listed any more,
 * or that the browser refuses, puts the choice back on the system default.
 */

const KEY = 'om_speaker';

let current: string | null = null;
const listeners = new Set<() => void>();

function canSwitch(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

/** The chosen speaker's device id; '' is the system default. */
export function speakerId(): string {
  if (current === null) {
    try {
      current = localStorage.getItem(KEY) ?? '';
    } catch {
      current = ''; // storage is closed: the choice lasts for this page
    }
  }
  return current;
}

export function setSpeaker(id: string): void {
  if (id === speakerId()) return;
  current = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode — the choice just doesn't persist */
  }
  for (const listener of [...listeners]) listener();
}

/**
 * Calls `listener` after every change of the choice. Returns an unsubscribe.
 * While anything listens, every device change is checked for the chosen speaker.
 */
export function onSpeakerChange(listener: () => void): () => void {
  if (listeners.size === 0 && typeof navigator !== 'undefined') {
    navigator.mediaDevices?.addEventListener?.('devicechange', dropIfGone);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof navigator !== 'undefined') {
      navigator.mediaDevices?.removeEventListener?.('devicechange', dropIfGone);
    }
  };
}

/** The outputs a person can choose among; none where the browser cannot switch. */
export function speakersIn(devices: readonly MediaDeviceInfo[]): MediaDeviceInfo[] {
  if (!canSwitch()) return [];
  // 'default' is the system default, which the pickers offer under a name of their own.
  return devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== '' && d.deviceId !== 'default');
}

/** The outputs the browser names when asked; none when it cannot be asked. */
export async function listSpeakers(): Promise<MediaDeviceInfo[]> {
  try {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
    return speakersIn(await navigator.mediaDevices.enumerateDevices());
  } catch {
    return [];
  }
}

function dropIfGone(): void {
  const id = speakerId();
  if (!id) return;
  void listSpeakers().then((list) => {
    // An empty list says nothing: without microphone permission the browser names no output.
    if (list.length > 0 && id === speakerId() && !list.some((d) => d.deviceId === id)) setSpeaker('');
  });
}

/**
 * Keeps `el` playing through the chosen speaker, from this call until the
 * returned function is called.
 */
export function followSpeaker(el: HTMLMediaElement): () => void {
  if (!canSwitch()) return () => {};
  // A switch can finish after the element was released; it must not move it then.
  let following = true;
  const apply = () => {
    const id = speakerId();
    // An element that was never moved reports no sink and plays on the default.
    if ((el.sinkId || '') === id) return;
    el.setSinkId(id).then(
      () => {
        // A choice made while the browser was still switching was compared with
        // the device the element was leaving, so look again.
        if (following && speakerId() !== id) apply();
      },
      () => {
        // Gone or refused. The system default is the one output that is always there.
        // Not for an element that was released: its failure says nothing about the device.
        if (following && id && id === speakerId()) setSpeaker('');
      }
    );
  };
  apply();
  const unsubscribe = onSpeakerChange(apply);
  return () => {
    following = false;
    unsubscribe();
  };
}

/**
 * Plays `stream` on this device, through the chosen speaker, until the returned
 * function is called. An element and not the audio graph's own output: the
 * browser suspends a graph whose output device goes away, and the graphs that
 * use this also feed the call and the recording.
 */
export function playLocally(stream: MediaStream): () => void {
  const el = document.createElement('audio');
  el.autoplay = true;
  el.srcObject = stream;
  document.body.append(el);
  const unfollow = followSpeaker(el);
  return () => {
    unfollow();
    el.srcObject = null;
    el.remove();
  };
}

/**
 * Which output device plays the call: one choice per browser, kept in
 * localStorage. '' is the system default.
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

/** Calls `listener` after every change of the choice. Returns an unsubscribe. */
export function onSpeakerChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The outputs a person can choose among; none where the browser cannot switch. */
export function speakersIn(devices: readonly MediaDeviceInfo[]): MediaDeviceInfo[] {
  if (!canSwitch()) return [];
  // 'default' is the system default, which the pickers offer under a name of their own.
  return devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== '' && d.deviceId !== 'default');
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
      () => {}
    );
  };
  apply();
  const unsubscribe = onSpeakerChange(apply);
  return () => {
    following = false;
    unsubscribe();
  };
}

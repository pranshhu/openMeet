import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Speaker = typeof import('@/lib/speaker');

const device = (kind: MediaDeviceKind, deviceId: string, label = deviceId): MediaDeviceInfo => ({
  kind,
  deviceId,
  label,
  groupId: 'g',
  toJSON: () => ({}),
});

/** Takes a sink the way a browser's element does. */
function fakeElement() {
  const state = { sinkId: '' };
  const setSinkId = vi.fn(async (id: string) => {
    state.sinkId = id;
  });
  return Object.assign(state, { setSinkId });
}
const asElement = (el: ReturnType<typeof fakeElement>) => el as unknown as HTMLMediaElement;
const forgetSetSinkId = () => {
  delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
};

describe('speaker', () => {
  let speaker: Speaker;

  beforeEach(async () => {
    localStorage.clear();
    // The choice is read from storage once per page: a fresh module is a fresh page.
    vi.resetModules();
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    speaker = await import('@/lib/speaker');
  });

  afterEach(forgetSetSinkId);

  it('starts on the system default and remembers a choice for the next visit', async () => {
    expect(speaker.speakerId()).toBe('');
    speaker.setSpeaker('out-b');
    expect(speaker.speakerId()).toBe('out-b');

    vi.resetModules();
    const nextVisit = await import('@/lib/speaker');
    expect(nextVisit.speakerId()).toBe('out-b');
  });

  it('holds the choice for this page when storage is closed', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(speaker.speakerId()).toBe('');
      speaker.setSpeaker('out-b');
      expect(speaker.speakerId()).toBe('out-b');
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('moves an element to the choice, at once and on every later change, until it is released', async () => {
    speaker.setSpeaker('out-a');
    const el = fakeElement();
    const release = speaker.followSpeaker(asElement(el));
    expect(el.sinkId).toBe('out-a');

    speaker.setSpeaker('out-b');
    expect(el.sinkId).toBe('out-b');
    speaker.setSpeaker('');
    expect(el.sinkId).toBe('');

    release();
    speaker.setSpeaker('out-a');
    // The three switches above finish only now, after the release and with the choice
    // moved since: none of them may move the element again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.sinkId).toBe('');
    expect(el.setSinkId).toHaveBeenCalledTimes(3);
  });

  it('leaves an element alone while the system default is chosen', () => {
    const el = fakeElement();
    speaker.followSpeaker(asElement(el));
    expect(el.setSinkId).not.toHaveBeenCalled();

    speaker.setSpeaker('out-a');
    speaker.setSpeaker('out-a');
    expect(el.setSinkId).toHaveBeenCalledTimes(1);
  });

  it('keeps going when the browser refuses a device', async () => {
    const el = fakeElement();
    el.setSinkId.mockRejectedValueOnce(new Error('refused'));
    speaker.followSpeaker(asElement(el));
    speaker.setSpeaker('out-gone');
    speaker.setSpeaker('out-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.sinkId).toBe('out-a');
  });

  it('ends on the last choice when it changes while the browser is still switching', async () => {
    // A browser reports the new sink only when the switch is done.
    const el = { sinkId: '', setSinkId: vi.fn() };
    const finish: (() => void)[] = [];
    el.setSinkId.mockImplementation(
      (id: string) =>
        new Promise<void>((resolve) => {
          finish.push(() => {
            el.sinkId = id;
            resolve();
          });
        })
    );
    speaker.followSpeaker(el as unknown as HTMLMediaElement);

    speaker.setSpeaker('out-a');
    // Back before the switch has finished: the element still reports the default.
    speaker.setSpeaker('');
    expect(el.setSinkId.mock.calls).toEqual([['out-a']]);

    finish.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.setSinkId.mock.calls).toEqual([['out-a'], ['']]);

    finish.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.sinkId).toBe('');
    expect(el.setSinkId).toHaveBeenCalledTimes(2);
  });

  it('lists the outputs a person can choose', () => {
    const all = [
      device('audioinput', 'mic-a'),
      device('videoinput', 'cam-a'),
      device('audiooutput', 'default', 'Default - Speakers'),
      device('audiooutput', 'out-a', 'Speakers'),
      device('audiooutput', 'out-b', 'Headphones'),
      // What a browser lists before it has microphone permission.
      device('audiooutput', '', ''),
    ];
    expect(speaker.speakersIn(all).map((d) => d.deviceId)).toEqual(['out-a', 'out-b']);
  });

  it('offers nothing and touches nothing where the browser cannot switch outputs', () => {
    forgetSetSinkId();
    expect(speaker.speakersIn([device('audiooutput', 'out-a')])).toEqual([]);

    const el = fakeElement();
    speaker.setSpeaker('out-a');
    speaker.followSpeaker(asElement(el));
    speaker.setSpeaker('out-b');
    expect(el.setSinkId).not.toHaveBeenCalled();
  });
});

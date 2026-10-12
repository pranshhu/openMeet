import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Speaker = typeof import('@/lib/speaker');

const output = (deviceId: string): MediaDeviceInfo => ({
  kind: 'audiooutput',
  deviceId,
  label: deviceId,
  groupId: 'g',
  toJSON: () => ({}),
});

/** Takes a sink the way a browser's element does, and refuses the ones it is told to. */
function fakeElement(refuse: (id: string) => boolean = () => false) {
  const state = { sinkId: '' };
  const setSinkId = vi.fn(async (id: string) => {
    if (refuse(id)) throw new Error('refused');
    state.sinkId = id;
  });
  return Object.assign(state, { setSinkId });
}
const asElement = (el: ReturnType<typeof fakeElement>) => el as unknown as HTMLMediaElement;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('speaker: a device that is refused or goes away', () => {
  let speaker: Speaker;
  let listed: MediaDeviceInfo[];
  let deviceChange: (() => void) | undefined;
  const removeEventListener = vi.fn();

  beforeEach(async () => {
    localStorage.clear();
    // The choice is read from storage once per page: a fresh module is a fresh page.
    vi.resetModules();
    listed = [output('default'), output('out-a'), output('out-b')];
    deviceChange = undefined;
    removeEventListener.mockClear();
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        enumerateDevices: vi.fn(async () => listed),
        addEventListener: vi.fn((type: string, handler: () => void) => {
          if (type === 'devicechange') deviceChange = handler;
        }),
        removeEventListener,
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    speaker = await import('@/lib/speaker');
  });

  afterEach(() => {
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    vi.unstubAllGlobals();
  });

  it('goes back to the system default when the browser refuses the device', async () => {
    const el = fakeElement((id) => id === 'out-gone');
    speaker.followSpeaker(asElement(el));
    speaker.setSpeaker('out-a');
    speaker.setSpeaker('out-gone');
    await settle();

    expect(speaker.speakerId()).toBe('');
    expect(localStorage.getItem('om_speaker')).toBe('');
    // Not left on the speaker chosen before: the picker says system default.
    expect(el.sinkId).toBe('');
  });

  it('goes back to the system default when the chosen device is unplugged', async () => {
    const el = fakeElement();
    speaker.followSpeaker(asElement(el));
    speaker.setSpeaker('out-b');

    listed = [output('default'), output('out-a')];
    deviceChange?.();
    await settle();

    expect(speaker.speakerId()).toBe('');
    expect(el.sinkId).toBe('');
  });

  it('keeps the choice while the device is listed, and while the browser names no output', async () => {
    const el = fakeElement();
    speaker.followSpeaker(asElement(el));
    speaker.setSpeaker('out-b');

    deviceChange?.();
    await settle();
    expect(speaker.speakerId()).toBe('out-b');

    listed = [];
    deviceChange?.();
    await settle();
    expect(speaker.speakerId()).toBe('out-b');
    expect(el.sinkId).toBe('out-b');
    // Both changes were looked at; the choice stayed because of what was listed.
    expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it('listens for device changes while anything follows the choice, and only then', () => {
    const first = speaker.followSpeaker(asElement(fakeElement()));
    const second = speaker.followSpeaker(asElement(fakeElement()));
    expect(deviceChange).toBeTypeOf('function');
    expect(navigator.mediaDevices.addEventListener).toHaveBeenCalledTimes(1);

    // One tile leaves the stage: the others are still watched over.
    first();
    expect(removeEventListener).not.toHaveBeenCalled();
    second();
    expect(removeEventListener).toHaveBeenCalledWith('devicechange', deviceChange);
  });

  it('keeps the choice when the refusal is for an element that was released', async () => {
    const el = fakeElement(() => true);
    const release = speaker.followSpeaker(asElement(el));
    speaker.setSpeaker('out-a');
    release();
    await settle();

    expect(el.setSinkId).toHaveBeenCalledWith('out-a');
    expect(speaker.speakerId()).toBe('out-a');
  });

  it('lists the outputs the browser names, and none when it cannot be asked', async () => {
    expect((await speaker.listSpeakers()).map((d) => d.deviceId)).toEqual(['out-a', 'out-b']);

    vi.stubGlobal('navigator', { userAgent: 'test' });
    expect(await speaker.listSpeakers()).toEqual([]);
  });

  it('lists no outputs when the browser refuses to name them', async () => {
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockRejectedValueOnce(new Error('denied'));
    expect(await speaker.listSpeakers()).toEqual([]);
  });

  it('asks the browser for nothing on a device change while no speaker is chosen', async () => {
    const el = fakeElement();
    speaker.followSpeaker(asElement(el));
    deviceChange?.();
    await settle();

    expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled();
    expect(speaker.speakerId()).toBe('');
  });

  it('keeps a choice made while the browser was naming the outputs', async () => {
    const el = fakeElement();
    speaker.followSpeaker(asElement(el));
    speaker.setSpeaker('out-b');
    let answer!: (list: MediaDeviceInfo[]) => void;
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockImplementationOnce(
      () => new Promise<MediaDeviceInfo[]>((resolve) => (answer = resolve))
    );

    deviceChange?.();
    speaker.setSpeaker('out-a');
    answer([output('default'), output('out-a')]);
    await settle();

    expect(speaker.speakerId()).toBe('out-a');
  });

  it('subscribes where the browser has no media devices, and still hears a change', () => {
    vi.stubGlobal('navigator', { userAgent: 'test' });
    const heard = vi.fn();
    const off = speaker.onSpeakerChange(heard);

    speaker.setSpeaker('out-a');
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });
});

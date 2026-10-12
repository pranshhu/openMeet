import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Lobby } from '@/components/Lobby';
import { setSpeaker, speakerId } from '@/lib/speaker';

// The preview tile listens to its stream, so the stream is an EventTarget.
function fakeStream(): MediaStream {
  const tracks = [
    { kind: 'audio', enabled: true, stop: vi.fn() },
    { kind: 'video', enabled: true, stop: vi.fn() },
  ];
  return Object.assign(new EventTarget(), {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  }) as unknown as MediaStream;
}

const DEVICES = [
  { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
  { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers' },
  { kind: 'audiooutput', deviceId: 'out-speakers', label: 'Speakers' },
  // A browser can name an output without a label.
  { kind: 'audiooutput', deviceId: 'out-headphones', label: '' },
];

const forgetSetSinkId = () => {
  delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
};
const speakerSelect = () => screen.findByRole('combobox', { name: 'Speaker' });

describe('Lobby speaker picker', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
        enumerateDevices: vi.fn().mockResolvedValue(DEVICES),
      },
    });
    // jsdom has no setSinkId; its presence is what says the browser can switch outputs.
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    // The lobby is still on screen here and shows the choice, so the reset is an update.
    act(() => {
      setSpeaker('');
    });
    localStorage.removeItem('om_speaker');
    forgetSetSinkId();
    vi.unstubAllGlobals();
  });

  it('offers the speakers between the microphone and the recording settings, on the system default', async () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = (await speakerSelect()) as HTMLSelectElement;

    expect(Array.from(select.options).map((o) => [o.value, o.text])).toEqual([
      ['', 'Speaker: System default'],
      ['out-speakers', 'Speaker: Speakers'],
      ['out-headphones', 'Speaker: Output 2'],
    ]);
    expect(select).toHaveValue('');
    const row = select.closest('label')!;
    // The select drops its native outline, so its box shows focus.
    expect(row.className).toMatch(/focus-within:ring/);
    const after = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(after(screen.getByLabelText('Microphone'), select)).toBeTruthy();
    expect(after(select, screen.getByLabelText('Recording quality'))).toBeTruthy();
  });

  it('keeps a choice made here for the call and for the next visit', async () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = await speakerSelect();
    fireEvent.change(select, { target: { value: 'out-speakers' } });

    expect(speakerId()).toBe('out-speakers');
    expect(localStorage.getItem('om_speaker')).toBe('out-speakers');
    expect(select).toHaveValue('out-speakers');
  });

  it('opens on the speaker chosen earlier, and on the system default when it is not listed', async () => {
    setSpeaker('out-headphones');
    const first = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(await speakerSelect()).toHaveValue('out-headphones');
    first.unmount();

    setSpeaker('out-not-here');
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(await speakerSelect()).toHaveValue('');
  });

  it('has no speaker row where the browser cannot switch outputs', async () => {
    forgetSetSinkId();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByLabelText('Microphone');
    // Once for the cameras and microphones, once for the speakers.
    await waitFor(() => expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByRole('combobox', { name: 'Speaker' })).toBeNull();
  });
});

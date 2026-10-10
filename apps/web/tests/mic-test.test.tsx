import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MicTest } from '@/components/MicTest';
import { PreflightPanel } from '@/components/PreflightPanel';
import { MIC_TEST_MS, recordMicSample } from '@/lib/mic-test';

class FakeRecorder {
  static made: FakeRecorder[] = [];
  static clip = 'voice';
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: MediaStream) {
    FakeRecorder.made.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([FakeRecorder.clip]) });
    this.onstop?.();
  }
}

const mic = (enabled = true) => ({ kind: 'audio', enabled }) as unknown as MediaStreamTrack;
const streamOf = (track: MediaStreamTrack) =>
  Object.assign(new EventTarget(), {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  }) as unknown as MediaStream;
const fiveSeconds = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(MIC_TEST_MS);
  });

beforeEach(() => {
  FakeRecorder.made = [];
  FakeRecorder.clip = 'voice';
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  URL.createObjectURL = vi.fn().mockReturnValue('blob:clip');
  URL.revokeObjectURL = vi.fn();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('recordMicSample', () => {
  it('records for the time asked and resolves with what the recorder produced', async () => {
    const clip = recordMicSample(mic(), MIC_TEST_MS, new AbortController().signal);
    const recorder = FakeRecorder.made[0]!;
    expect(recorder.state).toBe('recording');
    vi.advanceTimersByTime(MIC_TEST_MS - 1);
    expect(recorder.state).toBe('recording');
    vi.advanceTimersByTime(1);
    expect(recorder.state).toBe('inactive');
    expect((await clip).size).toBe(5);
  });

  it('ends early when it is aborted', async () => {
    const controller = new AbortController();
    const clip = recordMicSample(mic(), MIC_TEST_MS, controller.signal);
    controller.abort();
    expect(FakeRecorder.made[0]!.state).toBe('inactive');
    expect((await clip).size).toBe(5);
  });
});

describe('MicTest', () => {
  it('records the microphone, plays the clip back, then drops it', async () => {
    const track = mic();
    const { container } = render(<MicTest stream={streamOf(track)} />);
    // Nothing with role="status" until the button is pressed.
    expect(screen.queryByRole('status')).toBeNull();
    const button = screen.getByRole('button', { name: 'Test your mic' });
    expect(button.className).toMatch(/(^|\s)min-h-11(\s|$)/);

    fireEvent.click(button);
    expect(FakeRecorder.made[0]!.stream.getAudioTracks()).toEqual([track]);
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Recording 5 seconds. Say a few words.');

    await fiveSeconds();
    const audio = container.querySelector('audio')!;
    expect(audio).toHaveAttribute('src', 'blob:clip');
    expect(audio).toHaveAttribute('autoplay');
    expect(audio).toHaveAttribute('controls');
    expect(button).not.toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Playing it back. This is how your mic sounds.');

    fireEvent.ended(audio);
    expect(container.querySelector('audio')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clip');
    expect(screen.getByRole('status')).toHaveTextContent('Test deleted. It never left this browser.');
  });

  it('says the microphone is off instead of recording silence', () => {
    render(<MicTest stream={streamOf(mic(false))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test your mic' }));
    expect(FakeRecorder.made).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('Your microphone is off. Turn it on, then test again.');
  });

  it('stops the recorder when the page is left mid-test', () => {
    const { unmount } = render(<MicTest stream={streamOf(mic())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test your mic' }));
    expect(FakeRecorder.made[0]!.state).toBe('recording');
    unmount();
    expect(FakeRecorder.made[0]!.state).toBe('inactive');
  });

  it('says so when nothing was recorded', async () => {
    FakeRecorder.clip = '';
    const { container } = render(<MicTest stream={streamOf(mic())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test your mic' }));
    await fiveSeconds();
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('This browser could not record a test.');
  });

  it('says so when the browser cannot record a test', async () => {
    vi.stubGlobal(
      'MediaRecorder',
      class {
        constructor() {
          throw new Error('unsupported');
        }
      }
    );
    render(<MicTest stream={streamOf(mic())} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test your mic' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('This browser could not record a test.');
    expect(screen.getByRole('button', { name: 'Test your mic' })).not.toBeDisabled();
  });

  it('shows nothing without a microphone', () => {
    const { container } = render(<MicTest stream={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('makes no clip of a test that was cut short by leaving', async () => {
    const { unmount } = render(<MicTest stream={streamOf(mic())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test your mic' }));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('drops the clip that is playing when a new test starts', async () => {
    const { container } = render(<MicTest stream={streamOf(mic())} />);
    const button = screen.getByRole('button', { name: 'Test your mic' });
    fireEvent.click(button);
    await fiveSeconds();
    expect(container.querySelector('audio')).not.toBeNull();

    fireEvent.click(button);
    expect(container.querySelector('audio')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clip');
    expect(screen.getByRole('status')).toHaveTextContent('Recording 5 seconds. Say a few words.');
  });

  it('says so when the recorder fails part-way', async () => {
    render(<MicTest stream={streamOf(mic())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test your mic' }));
    await act(async () => {
      FakeRecorder.made[0]!.onerror?.();
    });
    expect(screen.getByRole('status')).toHaveTextContent('This browser could not record a test.');
    expect(screen.getByRole('button', { name: 'Test your mic' })).not.toBeDisabled();
  });

  it('does not render again while the panel around it does', () => {
    const stream = streamOf(mic());
    const getAudioTracks = vi.spyOn(stream, 'getAudioTracks');
    const { rerender } = render(<MicTest stream={stream} />);
    const renders = getAudioTracks.mock.calls.length;
    rerender(<MicTest stream={stream} />);
    expect(getAudioTracks.mock.calls.length).toBe(renders);
  });
});

describe('PreflightPanel', () => {
  it('offers the microphone test for the stream it checks', () => {
    const stream = streamOf(mic());
    render(
      <PreflightPanel slug="xyz-abcd-pqr" stream={stream} qualityId="720p" bitrateId="standard" isHost={false} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test your mic' }));
    expect(FakeRecorder.made[0]!.stream.getAudioTracks()).toEqual(stream.getAudioTracks());
  });
});

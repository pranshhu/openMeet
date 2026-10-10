import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CopyCheckResult } from '@/components/CopyCheckResult';
import { PreflightPanel } from '@/components/PreflightPanel';
import { resultText, type Check } from '@/lib/preflight';

const CHECKS: Check[] = [
  { id: 'mic', level: 'ok', message: 'Mic is picking up sound.' },
  { id: 'wav', level: 'warn', message: 'No uncompressed WAV master in this browser.' },
  { id: 'disk', level: 'fail', message: 'Only 0.4 GB of browser storage available (for backups)\u00a0— under an hour.' },
];

function streamWith(labels: { mic?: string; cam?: string } = {}): MediaStream {
  const audio = { kind: 'audio', enabled: true, label: labels.mic ?? '' };
  const video = {
    kind: 'video',
    enabled: true,
    label: labels.cam ?? '',
    getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }),
  };
  return Object.assign(new EventTarget(), {
    getTracks: () => [audio, video],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  }) as unknown as MediaStream;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resultText', () => {
  it('gives a title and one labelled line per check, with ordinary spaces', () => {
    expect(resultText(CHECKS, ['Microphone: USB Mic'])).toBe(
      [
        'openMeet setup check',
        'OK: Mic is picking up sound.',
        'Warning: No uncompressed WAV master in this browser.',
        'Problem: Only 0.4 GB of browser storage available (for backups) — under an hour.',
        'Microphone: USB Mic',
      ].join('\n')
    );
    expect(resultText([])).toBe('openMeet setup check');
  });
});

describe('CopyCheckResult', () => {
  it('copies the checks with the camera and microphone, and says what was copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { userAgent: 'test', clipboard: { writeText } });
    render(<CopyCheckResult checks={CHECKS} stream={streamWith({ mic: 'USB Mic', cam: 'Webcam' })} />);
    // Nothing with a live role until the button is pressed.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    const button = screen.getByRole('button', { name: 'Copy result' });
    expect(button.className).toMatch(/(^|\s)min-h-11(\s|$)/);

    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(
      resultText(CHECKS, ['Microphone: USB Mic', 'Camera: Webcam, 1280x720 @ 30fps'])
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Result copied: the checks above and the names of your camera and microphone. Paste it into a message to send it.'
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leaves out a camera and a microphone that are not there', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { userAgent: 'test', clipboard: { writeText } });
    render(<CopyCheckResult checks={CHECKS} stream={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy result' }));
    expect(writeText).toHaveBeenCalledWith(resultText(CHECKS));
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('says so when the clipboard refuses, or is not there', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const { unmount } = render(<CopyCheckResult checks={CHECKS} stream={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy result' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t copy. Select the checks above and copy them by hand.'
    );
    expect(screen.queryByRole('status')).toBeNull();
    unmount();

    vi.stubGlobal('navigator', { userAgent: 'test' });
    render(<CopyCheckResult checks={CHECKS} stream={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy result' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t copy.');
  });
});

describe('PreflightPanel', () => {
  it('copies the checks it shows', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { userAgent: 'test', clipboard: { writeText } });
    render(
      <PreflightPanel
        slug="xyz-abcd-pqr"
        stream={streamWith({ mic: 'USB Mic' })}
        qualityId="720p"
        bitrateId="standard"
        isHost={false}
      />
    );
    // jsdom has no MP4 recorder and no Web Audio, so these two lines are on screen.
    expect(screen.getByText('This browser cannot record MP4. Use Google Chrome.')).toBeInTheDocument();
    expect(screen.getByText('Listening…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy result' }));
    const text = writeText.mock.calls[0]![0] as string;
    const lines = text.split('\n');
    expect(lines[0]).toBe('openMeet setup check');
    expect(lines).toContain('Warning: Listening…');
    expect(lines).toContain('Problem: This browser cannot record MP4. Use Google Chrome.');
    expect(lines).toContain('Microphone: USB Mic');
    expect(lines).toContain('Camera: 1280x720 @ 30fps');
  });
});

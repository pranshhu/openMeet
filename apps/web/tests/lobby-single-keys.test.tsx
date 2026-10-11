import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Lobby } from '@/components/Lobby';
import { setSingleKeys, singleKeysOn } from '@/hooks/use-single-keys';

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

const HINT = 'A, V, C, T, M, N and ? in the call. Turn off if you use voice control or dictation.';
const box = () => screen.getByRole('checkbox', { name: 'Single-key shortcuts' });
/** Lets the lobby's own reads (backups, unsaved takes, the preview) finish. */
const settle = () => act(async () => {});

describe('Lobby: the switch for the single keys', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
  });

  afterEach(() => {
    // The lobby is still on screen here and shows the choice, so the reset is an update.
    act(() => {
      setSingleKeys(true);
    });
    localStorage.removeItem('om_single_keys');
    vi.unstubAllGlobals();
  });

  it('is on each of the three ways in: a ticked box with its words, in a row tall enough for a thumb', async () => {
    for (const [props, heading] of [
      [{}, 'Ready to join?'],
      [{ producer: true }, 'Join as a producer'],
      [{ present: true }, 'Ready to present?'],
    ] as const) {
      const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} {...props} />);
      await settle();
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      expect(box()).toBeChecked();
      expect(box().closest('label')).toHaveClass('min-h-11');
      expect(box()).toHaveAccessibleDescription(HINT);
      unmount();
    }
  });

  it('keeps a change made here for the call and for the next visit', async () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} producer />);
    await settle();
    fireEvent.click(box());
    expect(box()).not.toBeChecked();
    expect(singleKeysOn()).toBe(false);
    expect(localStorage.getItem('om_single_keys')).toBe('0');

    fireEvent.click(box());
    expect(box()).toBeChecked();
    expect(singleKeysOn()).toBe(true);
  });

  it('opens unticked for a person who turned the keys off earlier', async () => {
    act(() => {
      setSingleKeys(false);
    });
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await settle();
    expect(box()).not.toBeChecked();
  });

  it('is not on the check page, which joins no call', async () => {
    render(<Lobby slug="abc-defg-hij" onJoin={vi.fn()} checkOnly />);
    await settle();
    expect(screen.getByText('Check your setup')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Single-key shortcuts' })).toBeNull();
  });
});

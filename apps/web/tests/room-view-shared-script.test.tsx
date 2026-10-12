import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RoomView } from '@/components/RoomView';

// As in tests/room-view-screens.test.tsx: the hook is replaced by a fixed state.
let state: Record<string, unknown>;
let hook: Record<string, unknown>;

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({ state, join: vi.fn(), leave: vi.fn(), setMic: vi.fn(), setCam: vi.fn(), ...hook }),
}));

beforeEach(() => {
  localStorage.clear();
  hook = {};
  state = {
    phase: 'in-call',
    role: 'guest',
    companion: false,
    localStream: null,
    localName: 'Ana',
    connectionWarning: null,
    syncReportUrl: null,
    chaptersUrl: null,
    backupBlobUrl: null,
    wavBackupBlobUrl: null,
    takes: [],
    remoteStream: null,
    remotePeers: [],
    remoteScreenStream: null,
    localScreenStream: null,
    screenSharing: false,
    peerRecording: false,
    capabilities: {},
    finalizingGuests: [],
    messages: [],
    markers: [],
    summary: null,
    recordingError: null,
    incomingScript: null,
  };
});

describe('shared script', () => {
  it('hands the call the script the host sent, and the hook the answer', () => {
    state.incomingScript = 'Welcome to the show';
    hook.dismissIncomingScript = vi.fn();
    render(<RoomView slug="abc-defg-hij" />);

    const button = screen.getByRole('button', { name: 'Show teleprompter' });
    expect(within(button).getByTestId('badge')).toBeInTheDocument();
    fireEvent.click(button);
    const offer = screen.getByRole('group', { name: 'Script from the host' });
    fireEvent.click(within(offer).getByRole('button', { name: 'Ignore' }));
    expect(hook.dismissIncomingScript).toHaveBeenCalledTimes(1);
  });

  it('sends the host’s script through the hook', () => {
    state.role = 'host';
    hook.sendScript = vi.fn(() => true);
    render(<RoomView slug="abc-defg-hij" />);

    fireEvent.click(screen.getByRole('button', { name: 'Show teleprompter' }));
    fireEvent.change(screen.getByPlaceholderText(/paste your script/i), {
      target: { value: 'Intro, then the news' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to everyone' }));
    expect(hook.sendScript).toHaveBeenCalledWith('Intro, then the news');
  });
});

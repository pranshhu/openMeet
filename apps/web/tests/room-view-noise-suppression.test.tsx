import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    localName: 'Gita',
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
    drained: true,
    sidecarsSaved: false,
    noiseSuppression: false,
    noiseUnavailable: false,
  };
});

describe('noise suppression in the call', () => {
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Select microphone' }));

  it('hands the call the choice and the way to change it', async () => {
    state.noiseSuppression = true;
    const setNoiseSuppression = vi.fn(async () => null);
    hook.setNoiseSuppression = setNoiseSuppression;
    render(<RoomView slug="abc-defg-hij" />);

    openMenu();
    const box = screen.getByRole('checkbox', { name: 'Noise suppression' });
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(setNoiseSuppression).toHaveBeenCalledWith(false));
  });

  it('hands the call whether the browser can do it', () => {
    state.noiseUnavailable = true;
    hook.setNoiseSuppression = vi.fn(async () => null);
    render(<RoomView slug="abc-defg-hij" />);

    openMenu();
    expect(screen.getByRole('checkbox', { name: 'Noise suppression' })).toBeDisabled();
  });
});

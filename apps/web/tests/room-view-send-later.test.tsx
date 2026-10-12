import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
  };
});

describe('send my recording later', () => {
  it('hands the call the switch and its state', () => {
    state.sendLater = true;
    hook.setSendLater = vi.fn();
    render(<RoomView slug="abc-defg-hij" />);

    expect(screen.getByText(/Your recording stays on this device during a take/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select camera' }));
    const item = screen.getByRole('menuitemcheckbox', { name: 'Send my recording later' });
    expect(item).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(item);
    expect(hook.setSendLater).toHaveBeenCalledWith(false);
  });
});

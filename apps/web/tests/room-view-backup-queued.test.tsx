import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    phase: 'done',
    role: 'guest',
    companion: false,
    localStream: null,
    localName: 'Gita',
    connectionWarning: null,
    syncReportUrl: null,
    chaptersUrl: null,
    backupBlobUrl: 'blob:backup',
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
    drained: false,
    backupQueued: true,
    sidecarsSaved: false,
  };
});

describe('a take whose backup was offered to the host', () => {
  it('hands the call the flag', () => {
    render(<RoomView slug="abc-defg-hij" />);
    expect(
      screen.getByText('Your backup of this take holds all of it and was offered to the host.')
    ).toBeInTheDocument();
  });
});

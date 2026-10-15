import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
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
    look: {},
  };
});

describe('name tag colour', () => {
  const root = () => document.querySelector('.h-\\[100dvh\\]') as HTMLElement;

  it('hands the call the look the room state holds', () => {
    state.look = { accent: 'green' };
    render(<RoomView slug="abc-defg-hij" />);
    expect(root().style.getPropertyValue('--om-tag-bar')).toBe('3px solid #81c995');
  });

  it('draws no bar for the plain look', () => {
    render(<RoomView slug="abc-defg-hij" />);
    expect(root().style.getPropertyValue('--om-tag-bar')).toBe('');
  });
});

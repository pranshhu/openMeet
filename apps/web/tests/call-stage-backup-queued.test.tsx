import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';

const baseProps = {
  role: 'guest' as const,
  phase: 'done' as const,
  localStream: null,
  remoteStream: null,
  remotePeers: [],
  remoteScreenStream: null,
  localScreenStream: null,
  localName: 'Gita',
  peerName: 'Hana',
  screenSharing: false,
  canRecord: false,
  roomRecording: false,
  recordBlocked: false,
  messages: [],
  peerPresence: null,
  screenShareSupported: true,
  backupUrl: 'blob:backup',
  wavBackupUrl: null,
  syncReportUrl: null,
  recordingError: null,
  recordUnavailableReason: null,
  onToggleMic: vi.fn(),
  onToggleCam: vi.fn(),
  onRecord: vi.fn(),
  onEnd: vi.fn(),
  onLeave: vi.fn(),
  onSendChat: vi.fn(),
  slug: 'abc-defg-hij',
  onMark: vi.fn(),
  markerCount: 0,
  chaptersUrl: null,
  summary: null,
  takes: [],
  onNewTake: vi.fn(),
  onDiscardTake: vi.fn(),
  onOpenMediaBoard: vi.fn(() => null),
  onToggleScreen: vi.fn(),
  capabilities: {},
};

const QUEUED = 'Your backup of this take holds all of it and was offered to the host.';

describe('CallStage: a take whose backup was offered to the host', () => {
  it('tells the guest the backup holds all of it, and keeps the download', () => {
    render(<CallStage {...baseProps} drained={false} backupQueued />);
    expect(screen.getByText(QUEUED)).toBeInTheDocument();
    expect(screen.queryByText(/rejoin and press Send to host/)).toBeNull();
    expect(screen.queryByText(/Sent to the host\./)).toBeNull();
    expect(screen.getByRole('link', { name: 'Download your backup' })).toBeInTheDocument();
  });

  it('keeps the advice to rejoin when nothing was offered', () => {
    render(<CallStage {...baseProps} drained={false} />);
    expect(screen.queryByText(QUEUED)).toBeNull();
    expect(screen.getByText(/rejoin and press Send to host on your backup, or download it/)).toBeInTheDocument();
  });

  it('says a take that all arrived was sent, whatever the flag', () => {
    render(<CallStage {...baseProps} drained backupQueued />);
    expect(screen.getByText(/Sent to the host\./)).toBeInTheDocument();
    expect(screen.queryByText(QUEUED)).toBeNull();
  });
});

describe('CallStage: a take whose backup is held in memory only', () => {
  it('sends the guest to the download and not to a lobby that does not list it', () => {
    render(<CallStage {...baseProps} drained={false} backupInMemory />);
    expect(
      screen.getByText('Some of your recording may not have reached the host — download your backup.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/rejoin/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Download your backup' })).toBeInTheDocument();
  });

  it('keeps the advice to rejoin for a backup on disk', () => {
    render(<CallStage {...baseProps} drained={false} backupInMemory={false} />);
    expect(screen.getByText(/rejoin and press Send to host on your backup, or download it/)).toBeInTheDocument();
  });
});

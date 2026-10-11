import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';

const baseProps = {
  role: 'host' as const,
  phase: 'in-call' as const,
  localStream: null,
  remoteStream: null,
  remotePeers: [],
  remoteScreenStream: null,
  localScreenStream: null,
  localName: 'Alice',
  peerName: 'Bob',
  screenSharing: false,
  canRecord: true,
  roomRecording: false,
  recordBlocked: false,
  messages: [],
  peerPresence: null,
  screenShareSupported: true,
  backupUrl: null,
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

const bob = [{ peerId: 'p1', name: 'Bob', stream: null }];

describe('CallStage: the lobby answer on a name tag', () => {
  it.each([
    ['headphones', 'Bob — headphones'],
    ['speakers', 'Bob — on speakers'],
    ['speakers-ec', 'Bob — on speakers, echo cancelled'],
  ] as const)('shows the host a guest who said %s', (listening, tag) => {
    render(
      <CallStage
        {...baseProps}
        role="host"
        remoteStream={new EventTarget() as MediaStream}
        remotePeers={bob}
        capabilities={{ p1: { mp4: true, wav: true, listening } }}
      />
    );
    expect(screen.getByText(tag)).toBeInTheDocument();
  });

  it('puts the answer after the other notes about that guest', () => {
    render(
      <CallStage
        {...baseProps}
        role="host"
        remoteStream={new EventTarget() as MediaStream}
        remotePeers={bob}
        capabilities={{ p1: { mp4: true, wav: false, note: 'safari', listening: 'speakers' } }}
      />
    );
    expect(screen.getByText('Bob — Safari: video only; no WAV master; on speakers')).toBeInTheDocument();
  });

  it('adds no words for a guest who did not say', () => {
    render(
      <CallStage
        {...baseProps}
        role="host"
        remoteStream={new EventTarget() as MediaStream}
        remotePeers={bob}
        capabilities={{ p1: { mp4: true, wav: true } }}
      />
    );
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows the answer to the host only', () => {
    render(
      <CallStage
        {...baseProps}
        role="guest"
        remoteStream={new EventTarget() as MediaStream}
        remotePeers={bob}
        capabilities={{ p1: { mp4: true, wav: true, listening: 'speakers' } }}
      />
    );
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText(/on speakers/)).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RoomView } from '@/components/RoomView';
import { WaitingRoom } from '@/components/WaitingRoom';

/**
 * The screens of a host with nobody else in the room. The hook is replaced by
 * a fixed state, as in room-view-screens.test.tsx.
 */

let state: Record<string, unknown>;
let hook: Record<string, unknown>;

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({ state, join: vi.fn(), leave: vi.fn(), setMic: vi.fn(), setCam: vi.fn(), ...hook }),
}));

/** What recordCapability reads to call a browser able to record and to save to a folder. */
function canRecord() {
  vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
  vi.stubGlobal('showDirectoryPicker', () => {});
}

beforeEach(() => {
  hook = {};
  state = {
    phase: 'waiting',
    role: 'host',
    companion: false,
    localStream: null,
    localName: 'Ana',
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
    takes: [],
    summary: null,
    recordingError: null,
    connectionWarning: null,
    countdownEndsAt: null,
    syncReportUrl: null,
    chaptersUrl: null,
    backupBlobUrl: null,
    wavBackupBlobUrl: null,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WaitingRoom: continue alone', () => {
  it('is a 44 px button that asks to go on', () => {
    const onContinueAlone = vi.fn();
    render(
      <WaitingRoom role="host" localStream={null} localName="Ana" onLeave={vi.fn()} onContinueAlone={onContinueAlone} />
    );
    const button = screen.getByRole('button', { name: 'Continue alone' });
    expect(button.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(button);
    expect(onContinueAlone).toHaveBeenCalledTimes(1);
  });

  it('is absent when the page gives no way on', () => {
    render(<WaitingRoom role="host" localStream={null} localName="Ana" onLeave={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Continue alone' })).toBeNull();
  });
});

describe('a host who can record, with nobody else in the room', () => {
  it('goes on from the waiting room to the call screen, where Record and the invite link are', () => {
    canRecord();
    hook.recordWithCountdown = vi.fn();
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: 'Waiting for others to join' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start recording' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Continue alone' }));

    expect(screen.queryByRole('heading', { name: 'Waiting for others to join' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(hook.recordWithCountdown).toHaveBeenCalledTimes(1);
  });

  it('stays on the call screen while someone connects and after everyone has left', () => {
    canRecord();
    const { rerender } = render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue alone' }));

    for (const phase of ['connecting', 'peer-left', 'waiting']) {
      state = { ...state, phase };
      rerender(<RoomView slug="abc-defg-hij" />);
      expect(screen.getByRole('button', { name: 'Start recording' })).toBeInTheDocument();
      expect(screen.queryByText('Connecting…')).toBeNull();
      expect(screen.queryByText('Everyone else left')).toBeNull();
      expect(screen.queryByText('Waiting for others to join')).toBeNull();
    }
  });

  it('is offered the way on again when everyone else has left', () => {
    canRecord();
    Object.assign(state, { phase: 'peer-left' });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.getByRole('heading', { name: 'Everyone else left' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue alone' }));
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeInTheDocument();
  });

  // The waiting room never showed this notice; the call screen does, whoever
  // else is in the room.
  it('is shown the interrupted take of this room once on the call screen', () => {
    canRecord();
    hook.saveRecordingFromCall = vi.fn();
    Object.assign(state, { resumeOffer: { take: 1, canResume: false } });
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByText(/Recording was interrupted/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Continue alone' }));
    expect(
      screen.getByText('Recording was interrupted. This browser still has the take.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume recording' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save what was recorded' }));
    expect(hook.saveRecordingFromCall).toHaveBeenCalledTimes(1);
  });

  const cases: { who: string; extra: Record<string, unknown>; able: boolean }[] = [
    { who: 'a guest', extra: { role: 'guest' }, able: true },
    { who: 'a host on a present-only device', extra: { companion: true }, able: true },
    { who: 'a host whose browser cannot record', extra: {}, able: false },
  ];
  it.each(cases)('keeps the waiting room as it is for $who', ({ extra, able }) => {
    if (able) canRecord();
    Object.assign(state, extra);
    render(<RoomView slug="abc-defg-hij" />);
    expect(screen.queryByRole('button', { name: 'Continue alone' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
  });
});

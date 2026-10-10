import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';

// The starting props of tests/call-stage.test.tsx: a host in a call, nothing recording.
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

const guest = { ...baseProps, role: 'guest' as const, canRecord: false };
const announced = 'The host sent a script. Use it or ignore it in the teleprompter.';
const offer = () => screen.queryByRole('group', { name: 'Script from the host' });

beforeEach(() => localStorage.clear());

describe('CallStage: a script from the host', () => {
  it('puts a dot on the teleprompter button and announces the script while the offer is out of sight', () => {
    const { rerender } = render(<CallStage {...guest} incomingScript="Welcome to the show" />);
    const button = screen.getByRole('button', { name: 'Show teleprompter' });
    expect(within(button).getByTestId('badge')).toBeInTheDocument();
    expect(screen.getByTestId('status-bar')).toHaveTextContent(announced);

    // Opened: the offer is in sight, so the dot goes.
    fireEvent.click(button);
    expect(offer()).toBeInTheDocument();
    expect(screen.queryByTestId('badge')).toBeNull();

    // Answered: nothing is left of it.
    rerender(<CallStage {...guest} />);
    expect(offer()).toBeNull();
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent('The host sent a script');
    fireEvent.click(screen.getByRole('button', { name: 'Hide teleprompter' }));
    expect(screen.queryByTestId('badge')).toBeNull();
  });

  it('offers it inside the teleprompter and reports the answer', () => {
    const onDismissScript = vi.fn();
    render(<CallStage {...guest} incomingScript="Welcome to the show" onDismissScript={onDismissScript} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show teleprompter' }));
    fireEvent.click(within(offer()!).getByRole('button', { name: 'Use it' }));
    expect(onDismissScript).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Welcome to the show')).toBeInTheDocument();
  });

  it('gives the host, and only the host, a way to send the script', () => {
    const onSendScript = vi.fn(() => true);
    const { unmount } = render(<CallStage {...baseProps} onSendScript={onSendScript} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show teleprompter' }));
    fireEvent.change(screen.getByPlaceholderText(/paste your script/i), {
      target: { value: 'Intro, then the news' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to everyone' }));
    expect(onSendScript).toHaveBeenCalledWith('Intro, then the news');
    unmount();

    render(<CallStage {...guest} onSendScript={onSendScript} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show teleprompter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByPlaceholderText(/paste your script/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to everyone' })).toBeNull();
  });

  it('says nothing on a present-only device, which has no teleprompter', () => {
    render(<CallStage {...guest} companion incomingScript="Welcome to the show" />);
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent('The host sent a script');
    expect(screen.queryByRole('button', { name: /teleprompter/ })).toBeNull();
  });

  it('offers a producer the script and gives them no way to send one', () => {
    const onSendScript = vi.fn(() => true);
    render(
      <CallStage {...guest} role="producer" incomingScript="Welcome to the show" onSendScript={onSendScript} />
    );
    const button = screen.getByRole('button', { name: 'Show teleprompter' });
    expect(within(button).getByTestId('badge')).toBeInTheDocument();
    expect(screen.getByTestId('status-bar')).toHaveTextContent(announced);

    fireEvent.click(button);
    expect(offer()).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste your script/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to everyone' })).toBeNull();
  });
});

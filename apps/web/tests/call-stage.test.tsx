import { Profiler } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';
import { MIC_WARNING_TEXT } from '@/lib/mic-watch';

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

describe('CallStage layout', () => {
  // A bar floating over the stage covered the PiP, name tags, the bottom of a
  // shared screen and the summary's last links at one width or another. In the
  // flow, the stage simply ends where the bar begins, at every width.
  it('lays the control bar out below the stage instead of floating it over the stage', () => {
    render(<CallStage {...baseProps} />);
    const column = screen.getByTestId('stage-column');
    const main = screen.getByTestId('stage-main');
    const bar = Array.from(column.children).find((c) => c.contains(screen.getByLabelText('Leave call')))!;

    expect(main.contains(bar)).toBe(false);
    expect(main.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.className).not.toMatch(/\babsolute\b/);
    expect(main.className).not.toMatch(/(^|\s)pb-\d+/);
  });

  // Without it the column grows to the summary's min-content width (719px at a
  // 390px viewport) and the root's overflow-hidden clips the right half.
  it('lets the stage column shrink below its content width', () => {
    render(<CallStage {...baseProps} />);
    expect(screen.getByTestId('stage-column').className).toMatch(/\bmin-w-0\b/);
  });

  it("puts the guest's recording hint above the stage, not over it", () => {
    render(
      <CallStage
        {...baseProps}
        role="guest"
        canRecord={false}
        recordUnavailableReason="The host starts the recording for everyone — you’ll be captured automatically."
      />
    );
    const hint = screen.getByText(/The host starts the recording/);
    const column = screen.getByTestId('stage-column');
    expect(column.contains(hint)).toBe(false);
    expect(hint.compareDocumentPosition(column) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // In the flow, the toast pushed the stage down when a take started and back
  // up seven seconds later. It floats over the stage column instead, which
  // still keeps it off the Recording pill in the status bar.
  it('shows the consent toast over the stage column, below the status bar and its Recording pill', () => {
    render(<CallStage {...baseProps} role="guest" roomRecording />);
    const toast = screen.getByText('This call and chat are now being recorded');
    const pill = screen.getByText('Recording');
    const column = screen.getByTestId('stage-column');
    expect(pill.compareDocumentPosition(toast) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(column.contains(toast)).toBe(true);
    expect(column.contains(pill)).toBe(false);
    expect(column.className).toMatch(/\brelative\b/);
  });

  // A permanent pill between the status bar and the stage cost the guest a
  // row for the whole call and looked like the yellow warnings.
  it("puts the guest's recording hint in the status bar, not in a pill of its own", () => {
    render(
      <CallStage
        {...baseProps}
        role="guest"
        canRecord={false}
        recordUnavailableReason="The host starts the recording for everyone — you’ll be captured automatically."
      />
    );
    const hint = screen.getByText(/The host starts the recording/);
    expect(screen.getByTestId('status-bar').contains(hint)).toBe(true);
    expect(hint.className).not.toMatch(/rounded-full/);
  });

  it('keeps a real recording problem as a yellow line of its own under the status bar', () => {
    render(
      <CallStage
        {...baseProps}
        canRecord={false}
        recordBlocked
        recordUnavailableReason="This browser can’t record MP4."
      />
    );
    const warning = screen.getByText('This browser can’t record MP4.');
    expect(screen.getByTestId('status-bar').contains(warning)).toBe(false);
    expect(warning.className).toMatch(/text-\[#fdd663\]/);
  });

  // The waiting room was the only place with the invite link, and the host
  // leaves it as soon as the first guest arrives.
  it('gives the host a Copy invite link in the call, and not a guest', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      render(<CallStage {...baseProps} role="host" />);
      const invite = screen.getByRole('button', { name: 'Copy invite link' });
      expect(screen.getByTestId('status-bar').contains(invite)).toBe(true);
      await act(async () => {
        fireEvent.click(invite);
      });
      expect(writeText).toHaveBeenCalledWith(`${location.origin}${location.pathname}`);
      expect(screen.getByText('Link copied')).toBeInTheDocument();

      cleanup();
      render(<CallStage {...baseProps} role="guest" canRecord={false} />);
      expect(screen.queryByText('Copy invite link')).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  // Plain-http self-hosts have no clipboard, and a denied permission rejects:
  // either way the click must say something instead of doing nothing.
  it('tells the host when the invite link could not be copied', async () => {
    render(<CallStage {...baseProps} role="host" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }));
    expect(screen.getByText('Couldn’t copy — use the address bar')).toBeInTheDocument();

    cleanup();
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      render(<CallStage {...baseProps} role="host" />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }));
      });
      expect(screen.getByText('Couldn’t copy — use the address bar')).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('returns focus to the Chat button when chat is closed with Escape', async () => {
    render(<CallStage {...baseProps} />);
    fireEvent.click(screen.getByLabelText('Chat'));
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Escape' });
    expect(screen.queryByTestId('chat-column')).toBeNull();
    await waitFor(() => expect(screen.getByLabelText('Chat')).toHaveFocus());
  });

  // The mobile chat sheet is `absolute inset-0`: it fills whichever box is its
  // positioned ancestor. That box must not be the one holding the Recording
  // pill, or opening chat hides the only on-screen sign of the recording.
  it('keeps the Recording pill outside the box the mobile chat sheet fills', () => {
    render(<CallStage {...baseProps} role="guest" roomRecording />);
    fireEvent.click(screen.getByLabelText('Chat'));
    const sheetBox = screen.getByTestId('chat-column').parentElement!.closest('.relative')!;
    expect(sheetBox.contains(screen.getByText('Recording'))).toBe(false);
  });

  it('scopes the floating control bar to the stage column, not the chat column, so it stays centred over the stage when chat is open', () => {
    render(<CallStage {...baseProps} />);
    fireEvent.click(screen.getByLabelText('Chat'));

    const stageColumn = screen.getByTestId('stage-column');
    const chatColumn = screen.getByTestId('chat-column');
    const leaveButton = screen.getByLabelText('Leave call');

    expect(stageColumn.contains(leaveButton)).toBe(true);
    expect(chatColumn.contains(leaveButton)).toBe(false);
    expect(stageColumn.contains(chatColumn)).toBe(false);
  });
});

describe('CallStage chat unread indicator', () => {
  const msg = (text: string) => ({ from: 'guest' as const, text, ts: 1 });

  it('counts messages that arrive while chat is closed and clears on open', () => {
    const { rerender } = render(<CallStage {...baseProps} />);
    expect(screen.getByLabelText('Chat')).toBeInTheDocument();

    rerender(<CallStage {...baseProps} messages={[msg('a'), msg('b')]} />);
    const button = screen.getByLabelText('Chat, 2 unread');
    expect(button.querySelector('[data-testid="badge"]')).not.toBeNull();

    fireEvent.click(button);
    expect(screen.getByLabelText('Chat').querySelector('[data-testid="badge"]')).toBeNull();

    // Seen while open, so closing doesn't bring them back; only new ones count.
    rerender(<CallStage {...baseProps} messages={[msg('a'), msg('b'), msg('c')]} />);
    fireEvent.click(screen.getByLabelText('Chat'));
    expect(screen.getByLabelText('Chat')).toBeInTheDocument();
    rerender(<CallStage {...baseProps} messages={[msg('a'), msg('b'), msg('c'), msg('d')]} />);
    expect(screen.getByLabelText('Chat, 1 unread')).toBeInTheDocument();
  });
});

// The host can't tell who is actually being captured until it's too
// late (playback). This label is that warning, shown before Record is pressed.
describe('CallStage recording-capability labels', () => {
  it("tells the host a guest that can't encode MP4 won't be recorded", () => {
    render(
      <CallStage
        {...baseProps}
        role="host"
        remoteStream={{} as MediaStream}
        remotePeers={[{ peerId: 'p1', name: 'Bob', stream: null }]}
        capabilities={{ p1: { mp4: false, wav: true } }}
      />
    );
    expect(screen.getByText(/Bob.*won.t be recorded \(browser can.t record MP4\)/)).toBeInTheDocument();
  });

  it('repeats that warning on its own line, since name tags truncate', () => {
    render(
      <CallStage
        {...baseProps}
        role="host"
        remoteStream={{} as MediaStream}
        remotePeers={[{ peerId: 'p1', name: 'Bob', stream: null }]}
        capabilities={{ p1: { mp4: false, wav: true } }}
      />
    );
    expect(screen.getByText('Bob won’t be recorded — their browser can’t record MP4.')).toBeInTheDocument();
  });

  it('tells the host a guest with MP4 but no PCM path gets no WAV master', () => {
    render(
      <CallStage
        {...baseProps}
        role="host"
        remoteStream={{} as MediaStream}
        remotePeers={[{ peerId: 'p1', name: 'Bob', stream: null }]}
        capabilities={{ p1: { mp4: true, wav: false } }}
      />
    );
    expect(screen.getByText(/Bob.*no WAV master/)).toBeInTheDocument();
  });

  it('says nothing extra once both mp4 and wav are supported', () => {
    render(
      <CallStage
        {...baseProps}
        role="host"
        remoteStream={{} as MediaStream}
        remotePeers={[{ peerId: 'p1', name: 'Bob', stream: null }]}
        capabilities={{ p1: { mp4: true, wav: true } }}
      />
    );
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows short note on Safari guest tag for the host', () => {
    render(
      <CallStage
        {...baseProps}
        role="host"
        remoteStream={{} as MediaStream}
        remotePeers={[{ peerId: 'p1', name: 'Bob', stream: null }]}
        capabilities={{ p1: { mp4: true, wav: false, note: 'safari' } }}
      />
    );
    expect(screen.getByText('Bob — Safari: video only; no WAV master')).toBeInTheDocument();
  });

  it('shows short note on iPhone/iPad guest tag for the host', () => {
    render(
      <CallStage
        {...baseProps}
        role="host"
        remoteStream={{} as MediaStream}
        remotePeers={[{ peerId: 'p1', name: 'Bob', stream: null }]}
        capabilities={{ p1: { mp4: true, wav: false, note: 'ios' } }}
      />
    );
    expect(
      screen.getByText('Bob — iPhone/iPad: recording stops in background; no WAV master')
    ).toBeInTheDocument();
  });

  it('a guest viewer sees no capability label — only the host acts on it', () => {
    render(
      <CallStage
        {...baseProps}
        role="guest"
        remoteStream={{} as MediaStream}
        remotePeers={[{ peerId: 'p1', name: 'Bob', stream: null }]}
        capabilities={{ p1: { mp4: false, wav: true } }}
      />
    );
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText(/won.t be recorded/)).toBeNull();
  });

  it('with two remote peers, each tile gets its own name and presence', () => {
    const s1 = { id: 'stream-bob' } as unknown as MediaStream;
    const s2 = { id: 'stream-carol' } as unknown as MediaStream;
    render(
      <CallStage
        {...baseProps}
        localName="Alice"
        remoteStream={s1}
        remotePeers={[
          {
            peerId: 'p-bob',
            name: 'Bob',
            stream: s1,
            presence: { micOn: true, camOn: true, screenSharing: false },
          },
          {
            peerId: 'p-carol',
            name: 'Carol',
            stream: s2,
            presence: { micOn: false, camOn: false, screenSharing: true },
          },
        ]}
      />
    );

    expect(screen.getByText('Alice (You)')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Carol')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Muted' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Camera off' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Sharing screen' })).toBeInTheDocument();
  });

  it('renders "Mark this moment" for guests during recording, but not "End & save recording"', () => {
    render(<CallStage {...baseProps} role="guest" phase="recording" />);
    expect(screen.getByLabelText(/Mark this moment/)).toBeInTheDocument();
    expect(screen.queryByLabelText('End & save recording')).toBeNull();
  });

  it('renders "End & save recording" for host during recording', () => {
    render(<CallStage {...baseProps} role="host" phase="recording" />);
    expect(screen.getByLabelText(/Mark this moment/)).toBeInTheDocument();
    expect(screen.getByLabelText('End & save recording')).toBeInTheDocument();
  });

  // Record was a red circle beside the red Leave button, and both Record and
  // End & save were the same unlabeled disc, so neither said what it did.
  it('labels Record in words and keeps it out of the red Leave skin', () => {
    render(<CallStage {...baseProps} role="host" phase="in-call" />);
    const record = screen.getByRole('button', { name: 'Start recording' });
    expect(record).toHaveTextContent('Record');
    expect(record.className).not.toMatch(/bg-\[#ea4335\]/);
    expect(screen.getByRole('button', { name: 'Leave call' }).className).toMatch(/bg-\[#ea4335\]/);
  });

  it('shows End & save in words with a stop square, not the record dot', () => {
    render(<CallStage {...baseProps} role="host" phase="recording" />);
    const end = screen.getByRole('button', { name: 'End & save recording' });
    expect(end).toHaveTextContent('End & save');
    expect(end.querySelector('svg rect')).not.toBeNull();
    expect(end.querySelector('svg circle')).toBeNull();
  });

  // A take with no crash copy has to say so while it runs; one that has a copy,
  // or a call that is not recording, must stay quiet.
  it('tells the host when the running take has no crash copy', () => {
    render(<CallStage {...baseProps} phase="recording" unprotectedRecording />);
    const line = within(screen.getByTestId('status-bar')).getByRole('status');
    expect(line).toHaveTextContent('This take isn’t protected if the browser crashes.');
    expect(line.className).toMatch(/text-\[#fdd663\]/);
  });

  it('shows no crash-copy line for a protected take or outside a take', () => {
    const { rerender } = render(<CallStage {...baseProps} phase="recording" />);
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent(
      'protected if the browser crashes'
    );
    rerender(<CallStage {...baseProps} phase="in-call" unprotectedRecording />);
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent(
      'protected if the browser crashes'
    );
  });

  it('shows no crash-copy line when finalizing or done even if unprotected', () => {
    const { rerender } = render(
      <CallStage {...baseProps} phase="finalizing" unprotectedRecording />
    );
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent(
      'protected if the browser crashes'
    );
    rerender(<CallStage {...baseProps} phase="done" unprotectedRecording />);
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent(
      'protected if the browser crashes'
    );
  });

  // The warning belongs after the marker count, so a marker and a lost crash
  // copy read in the order they matter, not the other way round.
  it('keeps the crash-copy line after the marker count', () => {
    render(<CallStage {...baseProps} phase="recording" markerCount={1} unprotectedRecording />);
    const bar = screen.getByTestId('status-bar');
    const markers = within(bar).getByText('1 marker');
    const line = within(bar).getByRole('status');
    expect(markers.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("gives the guest's recovery button the words its banner tells them to press", () => {
    render(
      <CallStage
        {...baseProps}
        role="guest"
        phase="recording"
        recordingError="The connection to the room ended. Press Stop and save my recording to keep this recording."
      />
    );
    const stop = screen.getByRole('button', { name: 'Stop and save my recording' });
    expect(stop).toHaveTextContent('Stop and save');
    expect(stop.querySelector('svg rect')).not.toBeNull();
  });

  it('never shows the disconnect banner on the saved summary', () => {
    render(
      <CallStage
        {...baseProps}
        role="host"
        phase="done"
        recordingError="The other person disconnected. Press End & save to keep this recording."
      />
    );
    expect(
      screen.queryByText('The other person disconnected. Press End & save to keep this recording.')
    ).toBeNull();
  });

  it('shows host the real count of saved files in the status line', () => {
    const summary4 = {
      files: { host: 'host_1.mp4', guest: 'guest_1.mp4' },
      fileList: [
        { name: 'host_1.mp4', kind: 'video' as const },
        { name: 'guest_1.mp4', kind: 'video' as const },
        { name: 'host_1.wav', kind: 'audio' as const },
        { name: 'guest_1.wav', kind: 'audio' as const },
      ],
      audioMasters: { host: 'host_1.wav', guest: 'guest_1.wav' },
      screenFiles: [],
      alignment: '',
      backupNote: '',
      integrity: { ok: true, text: 'Integrity verified' },
      warnings: [],
      markers: [],
      commands: [],
    };

    const { rerender } = render(
      <CallStage {...baseProps} role="host" phase="done" summary={summary4} />
    );
    expect(screen.getByText(/Saved — 4 files in your recording folder\./)).toBeInTheDocument();

    const summary6 = {
      ...summary4,
      fileList: [
        ...summary4.fileList,
        { name: 'guest2_1.mp4', kind: 'video' as const },
        { name: 'guest2_1.wav', kind: 'audio' as const },
      ],
    };

    rerender(<CallStage {...baseProps} role="host" phase="done" summary={summary6} />);
    expect(screen.getByText(/Saved — 6 files in your recording folder\./)).toBeInTheDocument();
  });

  it('shows guest role-appropriate copy without host-only file count', () => {
    render(<CallStage {...baseProps} role="guest" phase="done" />);
    expect(screen.getByText(/Sent to the host\./)).toBeInTheDocument();
    expect(screen.queryByText(/Saved — \d+ files/)).toBeNull();
    expect(screen.queryByText(/Saved — two files/)).toBeNull();
  });

  // A guest can't see the host's disk, and the drain can give up at its cap:
  // "Saved" there was a promise the app couldn't keep, and gave no reason to
  // send the backup that holds the rest.
  it('tells a guest whose last seconds may not have arrived to rejoin and send their backup', () => {
    render(<CallStage {...baseProps} role="guest" phase="done" drained={false} backupUrl="blob:backup" />);
    expect(
      screen.getByText(/may not have reached the host — rejoin and press Send to host on your backup, or download it/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Sent to the host/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Download your backup' })).toBeInTheDocument();
  });

  it('hides the Saved status line on a guest while roomRecording is still true', () => {
    render(<CallStage {...baseProps} role="guest" phase="done" roomRecording={true} />);
    expect(screen.getByText('Recording')).toBeInTheDocument();
    expect(screen.queryByText(/Sent to the host/)).toBeNull();
    expect(screen.queryByText(/Saved —/)).toBeNull();
  });

  it('renders presenter placeholder for the local sharer when no remote screen is shown', () => {
    render(
      <CallStage
        {...baseProps}
        screenSharing={true}
        remoteScreenStream={null}
        localScreenStream={null}
      />
    );
    expect(screen.getByText(/you’re presenting/i)).toBeInTheDocument();
    expect(screen.getByText('Everyone in the call can see what you’re sharing.')).toBeInTheDocument();
  });

  it('stops presenting from the placeholder with a plain toggle, no source', () => {
    const onToggleScreen = vi.fn();
    render(<CallStage {...baseProps} screenSharing onToggleScreen={onToggleScreen} />);
    const stops = screen.getAllByRole('button', { name: 'Stop presenting' });
    expect(stops).toHaveLength(2); // the control bar's and the placeholder's
    fireEvent.click(stops.find((b) => b.textContent === 'Stop presenting')!);
    expect(onToggleScreen).toHaveBeenCalledWith();
  });

  // A phone showing its rear camera has to see what it is aiming at.
  it('shows the rear camera itself, not the placeholder, when a self-preview is passed', () => {
    render(
      <CallStage
        {...baseProps}
        screenSharing
        presentingRearCamera
        localScreenStream={{ id: 'rear' } as unknown as MediaStream}
      />
    );
    expect(screen.getByText('Your rear camera')).toBeInTheDocument();
    expect(screen.queryByText(/you’re presenting/i)).toBeNull();
  });

  it('renders presenter screen label with presenter name when remote screen is shown', () => {
    render(
      <CallStage
        {...baseProps}
        screenSharing={false}
        remoteScreenStream={{} as MediaStream}
        peerName="Bob"
      />
    );
    expect(screen.getByText("Bob's screen")).toBeInTheDocument();
  });

  it('names the screen after the peer who is sharing, not the first peer, in a group call', () => {
    render(
      <CallStage
        {...baseProps}
        remoteScreenStream={{} as MediaStream}
        remotePeers={[
          { peerId: 'p1', name: 'Bob', stream: null, presence: { micOn: true, camOn: true, screenSharing: false } },
          { peerId: 'p2', name: 'Cara', stream: null, presence: { micOn: true, camOn: true, screenSharing: true } },
        ]}
      />
    );
    expect(screen.getByText("Cara's screen")).toBeInTheDocument();
  });

  it('without getDisplayMedia the Present control offers photo/video and rear camera options', () => {
    const onToggleScreen = vi.fn();
    render(<CallStage {...baseProps} screenShareSupported={false} onToggleScreen={onToggleScreen} />);

    // Present button is enabled (not disabled with phones can't present message),
    // and says what a phone can actually present.
    const presentBtn = screen.getByLabelText(/Present/i);
    expect(presentBtn).not.toBeDisabled();
    expect(presentBtn).toHaveAccessibleName('Present a photo, video or your rear camera');
    expect(screen.queryByText('A photo or video')).toBeNull();
    expect(screen.queryByText('Rear camera')).toBeNull();

    // Clicking opens menu
    fireEvent.click(presentBtn);
    expect(screen.getByText('A photo or video')).toBeInTheDocument();
    expect(screen.getByText('Rear camera')).toBeInTheDocument();

    const fileInput = document.querySelector('input[type="file"][accept*="image/"][accept*="video/"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    // Selecting a file triggers onToggleScreen with the file
    const file = new File(['test'], 'photo.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(onToggleScreen).toHaveBeenCalledWith(file);

    // Clean up and test clicking Rear camera option
    cleanup();
    const onToggleScreen2 = vi.fn();
    render(<CallStage {...baseProps} screenShareSupported={false} onToggleScreen={onToggleScreen2} />);
    const presentBtn2 = screen.getByLabelText(/Present/i);
    fireEvent.click(presentBtn2);
    const rearBtn = screen.getByText('Rear camera');
    fireEvent.click(rearBtn);
    expect(onToggleScreen2).toHaveBeenCalledWith('rear-camera');
  });

  it('with getDisplayMedia present, Present control toggles directly with no menu', () => {
    const onToggleScreen = vi.fn();
    render(<CallStage {...baseProps} screenShareSupported={true} onToggleScreen={onToggleScreen} />);

    const presentBtn = screen.getByLabelText('Present screen');
    fireEvent.click(presentBtn);
    expect(onToggleScreen).toHaveBeenCalled();
    expect(screen.queryByText('A photo or video')).toBeNull();
    expect(screen.queryByText('Rear camera')).toBeNull();
  });

  it('shows placeholder instead of video frame when presenting rear camera on mobile device', () => {
    const origUserAgent = navigator.userAgent;
    try {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        configurable: true,
      });
      const dummyTrack = { kind: 'video', readyState: 'ended', enabled: true } as any;
      const dummyStream = {
        getVideoTracks: () => [dummyTrack],
        getAudioTracks: () => [],
      } as any;

      const { container } = render(
        <CallStage
          {...baseProps}
          localStream={dummyStream}
          screenSharing={true}
          presentingRearCamera={true}
        />
      );
      // When placeholder is shown, VideoTile video has opacity-0
      const localVideo = container.querySelector('video');
      expect(localVideo).toHaveClass('opacity-0');
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: origUserAgent,
        configurable: true,
      });
    }
  });
});

describe('CallStage self-view', () => {
  // Mirrored like the lobby preview; the recording and the remote tiles never are.
  it('mirrors your own camera tile and no one else’s', () => {
    const video = { kind: 'video', enabled: true, getSettings: () => ({ facingMode: 'user' }) };
    const local = {
      id: 'local',
      getTracks: () => [video],
      getAudioTracks: () => [],
      getVideoTracks: () => [video],
    } as unknown as MediaStream;
    const bob = { id: 'stream-bob' } as unknown as MediaStream;
    render(
      <CallStage
        {...baseProps}
        localStream={local}
        remoteStream={bob}
        remotePeers={[{ peerId: 'p-bob', name: 'Bob', stream: bob }]}
      />
    );
    const pip = screen.getByRole('button', { name: 'Swap spotlight' }).querySelector('video')!;
    const big = Array.from(document.querySelectorAll('video')).find((v) => !pip.isSameNode(v))!;
    expect(pip).toHaveClass('-scale-x-100');
    expect(big).not.toHaveClass('-scale-x-100');
  });
});

describe('CallStage initial device state from stream', () => {
  it('initializes mic control as off when local stream audio track is disabled', () => {
    const disabledAudioTrack = { kind: 'audio', enabled: false } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [disabledAudioTrack],
      getVideoTracks: () => [],
    } as unknown as MediaStream;

    render(<CallStage {...baseProps} localStream={stream} />);

    const micBtn = screen.getByLabelText('Turn on microphone');
    expect(micBtn).toBeInTheDocument();
    expect(screen.queryByLabelText('Turn off microphone')).toBeNull();

    // Clicking turns it on with a single click
    fireEvent.click(micBtn);
    expect(baseProps.onToggleMic).toHaveBeenCalledWith(true);
    expect(screen.getByLabelText('Turn off microphone')).toBeInTheDocument();
  });

  it('initializes cam control as off when local stream video track is disabled', () => {
    const disabledVideoTrack = { kind: 'video', enabled: false } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [],
      getVideoTracks: () => [disabledVideoTrack],
    } as unknown as MediaStream;

    render(<CallStage {...baseProps} localStream={stream} />);

    const camBtn = screen.getByLabelText('Turn on camera');
    expect(camBtn).toBeInTheDocument();
    expect(screen.queryByLabelText('Turn off camera')).toBeNull();

    // Clicking turns it on with a single click
    fireEvent.click(camBtn);
    expect(baseProps.onToggleCam).toHaveBeenCalledWith(true);
    expect(screen.getByLabelText('Turn off camera')).toBeInTheDocument();
  });

  it('does not render peers with role=producer as stage tiles', () => {
    const s1 = { id: 'stream-bob' } as unknown as MediaStream;
    render(
      <CallStage
        {...baseProps}
        localName="Alice"
        remoteStream={s1}
        remotePeers={[
          {
            peerId: 'p-bob',
            name: 'Bob',
            stream: s1,
            presence: { micOn: true, camOn: true, screenSharing: false },
            role: 'guest',
          },
          {
            peerId: 'p-pat',
            name: 'Pat Producer',
            stream: null,
            presence: { micOn: false, camOn: false, screenSharing: false },
            role: 'producer',
          },
        ]}
      />
    );

    expect(screen.getByText('Alice (You)')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Pat Producer')).toBeNull();
  });

  it('producer in-call copy says watching and not recorded, with no "you will be captured" claim', () => {
    render(
      <CallStage
        {...baseProps}
        role="producer"
        canRecord={false}
        recordUnavailableReason="You’re a producer — you are watching and are not recorded."
      />
    );
    expect(screen.getByText(/you are watching and are not recorded/i)).toBeInTheDocument();
    expect(screen.queryByText(/you.ll be captured automatically/i)).toBeNull();
  });

  it('shows WAV backup link only when wavBackupUrl is provided in done phase', () => {
    const { rerender } = render(
      <CallStage
        {...baseProps}
        phase="done"
        backupUrl="blob:backup"
        wavBackupUrl={null}
      />
    );
    expect(screen.getByText('Download your backup')).toBeInTheDocument();
    expect(screen.queryByText('Download your WAV backup')).toBeNull();

    rerender(
      <CallStage
        {...baseProps}
        phase="done"
        backupUrl="blob:backup"
        wavBackupUrl="blob:wav-backup"
      />
    );
    const wavLink = screen.getByText('Download your WAV backup');
    expect(wavLink).toBeInTheDocument();
    expect(wavLink.getAttribute('href')).toBe('blob:wav-backup');
    // Named for the room and whose copy it is, so backups sent to the host
    // don't all arrive as backup.wav.
    expect(wavLink.getAttribute('download')).toBe('openmeet-abc-defg-hij-backup-alice.wav');
  });

  it('keeps a name written with combining marks whole in the download name', () => {
    render(
      <CallStage {...baseProps} phase="done" localName="प्रांशु" backupUrl="blob:backup" wavBackupUrl="blob:wav-backup" />
    );
    expect(screen.getByText('Download your WAV backup').getAttribute('download')).toBe(
      'openmeet-abc-defg-hij-backup-प्रांशु.wav'
    );
  });

  it('falls back to the role in the download name when the name has nothing usable', () => {
    render(
      <CallStage {...baseProps} phase="done" role="guest" localName="😀" backupUrl="blob:backup" wavBackupUrl="blob:wav-backup" />
    );
    expect(screen.getByText('Download your WAV backup').getAttribute('download')).toBe(
      'openmeet-abc-defg-hij-backup-guest.wav'
    );
  });

  it('companion peer has no camera tile on the stage', () => {
    const s1 = { id: 'stream-bob' } as unknown as MediaStream;
    render(
      <CallStage
        {...baseProps}
        localName="Alice"
        remoteStream={s1}
        remotePeers={[
          {
            peerId: 'p-bob',
            name: 'Bob',
            stream: s1,
            presence: { micOn: true, camOn: true, screenSharing: false },
            role: 'guest',
          },
          {
            peerId: 'p-colin',
            name: 'Colin Companion',
            stream: null,
            presence: { micOn: false, camOn: false, screenSharing: false },
            role: 'guest',
            companion: true,
          },
        ]}
      />
    );

    expect(screen.getByText('Alice (You)')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Colin Companion')).toBeNull();
  });

  it('companion peer sharing screen labels the screen as Name (Presenting)', () => {
    const fakeScreen = { id: 'scr-companion' } as unknown as MediaStream;
    render(
      <CallStage
        {...baseProps}
        remoteScreenStream={fakeScreen}
        remotePeers={[
          {
            peerId: 'p-colin',
            name: 'Colin',
            stream: null,
            presence: { micOn: false, camOn: false, screenSharing: true },
            role: 'guest',
            companion: true,
          },
        ]}
      />
    );

    expect(screen.getByText('Colin (Presenting)')).toBeInTheDocument();
    expect(screen.queryByText("Colin's screen")).toBeNull();
  });

  // A producer joins with no tracks: the toggles showed red and did nothing,
  // and the media board opened empty with no mic to mix into.
  it('producer client has no mic or camera buttons and no media board', () => {
    render(<CallStage {...baseProps} role="producer" canRecord={false} />);
    expect(screen.queryByRole('button', { name: /turn (on|off) microphone/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /turn (on|off) camera/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /select (microphone|camera)/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Media board' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave call' })).toBeInTheDocument();
  });

  it('companion client has no mic or camera buttons but keeps present, chat, leave', () => {
    render(
      <CallStage
        {...baseProps}
        companion={true}
      />
    );

    expect(screen.queryByLabelText(/microphone/i)).toBeNull();
    expect(screen.queryByLabelText(/camera/i)).toBeNull();
    expect(screen.getByLabelText(/present screen/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/chat/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/leave call/i)).toBeInTheDocument();
  });
});

describe('CallStage chat preview pop-up and title updates', () => {
  const remoteMsg = (text: string, fromName?: string) => ({
    from: 'guest' as const,
    text,
    ts: 1,
    ...(fromName ? { fromName } : {}),
  });
  const selfMsg = (text: string) => ({
    from: 'host' as const,
    text,
    ts: 1,
    self: true,
  });

  it('shows the sender and text when a remote message arrives with chat closed', () => {
    const { rerender } = render(<CallStage {...baseProps} />);
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<CallStage {...baseProps} messages={[remoteMsg('Hello world', 'Bob')]} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('shows nothing when a self message arrives', () => {
    const { rerender } = render(<CallStage {...baseProps} />);
    rerender(<CallStage {...baseProps} messages={[selfMsg('My own message')]} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing when a message arrives with chat open', () => {
    const { rerender } = render(<CallStage {...baseProps} />);
    fireEvent.click(screen.getByLabelText('Chat'));
    expect(screen.getByTestId('chat-column')).toBeInTheDocument();

    rerender(<CallStage {...baseProps} messages={[remoteMsg('Hello there', 'Bob')]} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('opens chat when the pop-up is clicked and dismisses the pop-up', () => {
    const { rerender } = render(<CallStage {...baseProps} />);
    rerender(<CallStage {...baseProps} messages={[remoteMsg('Click me', 'Bob')]} />);

    fireEvent.click(screen.getByRole('button', { name: /Bob.*Click me/ }));

    expect(screen.getByTestId('chat-column')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disappears after the timeout (fake timers)', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<CallStage {...baseProps} />);
      rerender(<CallStage {...baseProps} messages={[remoteMsg('Expiring soon', 'Bob')]} />);
      expect(screen.getByRole('status')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('truncates a long message with an ellipsis', () => {
    const { rerender } = render(<CallStage {...baseProps} />);
    const longText = 'x'.repeat(150);
    rerender(<CallStage {...baseProps} messages={[remoteMsg(longText, 'Bob')]} />);

    const expected = `${'x'.repeat(120)}…`;
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(longText)).toBeNull();
  });

  it('prefixes document.title with the unread count while hidden and loses it when visible', () => {
    document.title = 'openMeet';
    const originalHidden = document.hidden;
    try {
      Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
      const { rerender } = render(<CallStage {...baseProps} />);
      rerender(<CallStage {...baseProps} messages={[remoteMsg('One'), remoteMsg('Two')]} />);

      expect(document.title).toBe('(2) openMeet');

      Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(document.title).toBe('openMeet');
    } finally {
      Object.defineProperty(document, 'hidden', { value: originalHidden, writable: true, configurable: true });
      document.title = 'openMeet';
    }
  });

  it('prefixes document.title with ● REC while hidden during a take, including unread count', () => {
    document.title = 'openMeet';
    const originalHidden = document.hidden;
    try {
      Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
      const { rerender, unmount } = render(<CallStage {...baseProps} phase="recording" />);

      expect(document.title).toBe('● REC openMeet');

      rerender(
        <CallStage
          {...baseProps}
          phase="recording"
          messages={[remoteMsg('One'), remoteMsg('Two'), remoteMsg('Three')]}
        />
      );
      expect(document.title).toBe('● REC (3) openMeet');

      Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(document.title).toBe('openMeet');

      Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(document.title).toBe('● REC (3) openMeet');

      unmount();
      expect(document.title).toBe('openMeet');
    } finally {
      Object.defineProperty(document, 'hidden', { value: originalHidden, writable: true, configurable: true });
      document.title = 'openMeet';
    }
  });

  it('shows background and battery notes with role status, and dismiss button works', async () => {
    class FakeBattery extends EventTarget {
      charging = false;
      level = 0.08;
    }
    const fakeBattery = new FakeBattery();
    Object.defineProperty(navigator, 'getBattery', {
      value: vi.fn().mockResolvedValue(fakeBattery),
      configurable: true,
      writable: true,
    });
    let hidden = false;
    Object.defineProperty(document, 'hidden', {
      get: () => hidden,
      configurable: true,
    });

    try {
      vi.useFakeTimers();
      render(<CallStage {...baseProps} phase="recording" />);
      await act(async () => {});

      // Battery note is shown with role status
      const batteryNotice = screen
        .getByText(/Battery at 8% and not charging/)
        .closest('[role="status"]')!;
      expect(batteryNotice).toBeInTheDocument();
      expect(batteryNotice.className).toMatch(/text-\[#fdd663\]/);
      expect(batteryNotice.getAttribute('role')).toBe('status');

      // Hide tab for 5s
      act(() => {
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        vi.advanceTimersByTime(5000);
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });

      const bgNotice = screen
        .getByText(/This tab was in the background for 5 s/)
        .closest('[role="status"]')!;
      expect(bgNotice).toBeInTheDocument();
      expect(bgNotice.className).toMatch(/text-\[#fdd663\]/);
      expect(bgNotice.getAttribute('role')).toBe('status');


      // Dismiss button removes background note
      const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
      act(() => {
        fireEvent.click(dismissBtn);
      });
      expect(screen.queryByText(/This tab was in the background/)).toBeNull();
      // Battery note still present
      expect(screen.getByText(/Battery at 8% and not charging/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(navigator, 'getBattery');
    }
  });


  it('shows no pop-up for messages that were already there on mount', () => {
    render(<CallStage {...baseProps} messages={[remoteMsg('Old message', 'Bob')]} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});






describe('CallStage after a take', () => {
  const summary = {
    files: { host: 'host_1.mp4', guest: 'guest_1.mp4' },
    fileList: [
      { name: 'host_1.mp4', kind: 'video' as const },
      { name: 'guest_1.mp4', kind: 'video' as const },
    ],
    audioMasters: { host: null },
    screenFiles: [],
    alignment: '',
    backupNote: '',
    integrity: { ok: true, text: 'Integrity verified' },
    warnings: [],
    markers: [],
    commands: [],
  };
  const bob = { id: 'stream-bob' } as unknown as MediaStream;
  const doneProps = {
    ...baseProps,
    role: 'host' as const,
    phase: 'done' as const,
    summary,
    takes: [{ take: 2, durationMs: 60_000, discarded: false }],
    syncReportUrl: 'blob:sync',
    backupUrl: 'blob:backup',
    remoteStream: bob,
    remotePeers: [{ peerId: 'p-bob', name: 'Bob', stream: bob }],
  };

  // The summary replaced the whole stage while the call carried on, so the
  // host couldn't see the guest between takes, or tell that they had left.
  it('shows the summary beside the stage, not instead of it, and closes back to the call', async () => {
    render(<CallStage {...doneProps} />);
    expect(screen.getByTestId('stage-main')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByTestId('summary-column')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to the call' }));
    expect(screen.queryByTestId('summary-column')).toBeNull();
    expect(screen.getByTestId('stage-main')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show session summary' })).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Show session summary' }));
    expect(screen.getByTestId('summary-column')).toBeInTheDocument();
  });

  it('never shows chat and the summary side by side', () => {
    render(<CallStage {...doneProps} />);
    fireEvent.click(screen.getByLabelText('Chat'));
    expect(screen.getByTestId('chat-column')).toBeInTheDocument();
    expect(screen.queryByTestId('summary-column')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show session summary' }));
    expect(screen.getByTestId('summary-column')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-column')).toBeNull();
  });

  // Closing chat when the take ended threw away whatever was being typed.
  it('leaves chat and its draft open when the take ends, with the summary a click away', () => {
    const { rerender } = render(<CallStage {...doneProps} phase="recording" summary={null} />);
    fireEvent.click(screen.getByLabelText('Chat'));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'one more thing' } });
    rerender(<CallStage {...doneProps} />);
    expect(screen.getByLabelText('Message')).toHaveValue('one more thing');
    expect(screen.queryByTestId('summary-column')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show session summary' }));
    expect(screen.getByTestId('summary-column')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-column')).toBeNull();
  });

  it('opens the summary when the take ends with chat closed', () => {
    const { rerender } = render(<CallStage {...doneProps} phase="recording" summary={null} />);
    rerender(<CallStage {...doneProps} />);
    expect(screen.getByTestId('summary-column')).toBeInTheDocument();
  });

  // A finalize that threw used to hold 'finalizing' for good, with Leave off.
  // Without a summary the host's line said "Saved — 0 files".
  it('says saving did not finish, keeps the backup to hand, and lets the host leave', () => {
    const onLeave = vi.fn();
    render(
      <CallStage
        {...baseProps}
        phase="done"
        recordingError="Saving didn’t finish (disk full). Some files in your recording folder may be incomplete."
        backupUrl="blob:backup"
        onLeave={onLeave}
      />
    );
    const bar = screen.getByTestId('status-bar');
    expect(bar).toHaveTextContent('Saving didn’t finish.');
    expect(bar).not.toHaveTextContent(/Saved/);
    expect(screen.getByRole('link', { name: 'Download your backup' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/disk full/);
    const leave = screen.getByRole('button', { name: 'Leave call' });
    expect(leave).toBeEnabled();
    fireEvent.click(leave);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  // It used to only reset the take and drop the host back on the call, not
  // recording, while its label said otherwise.
  it('really records when Record another take is pressed', () => {
    const onNewTake = vi.fn();
    const onRecord = vi.fn();
    render(<CallStage {...doneProps} onNewTake={onNewTake} onRecord={onRecord} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record another take' }));
    expect(onNewTake).toHaveBeenCalledTimes(1);
    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onNewTake.mock.invocationCallOrder[0]!).toBeLessThan(onRecord.mock.invocationCallOrder[0]!);
  });

  it('keeps a Record button in the bar between takes', () => {
    const onNewTake = vi.fn();
    const onRecord = vi.fn();
    render(<CallStage {...doneProps} onNewTake={onNewTake} onRecord={onRecord} />);
    const record = screen.getByRole('button', { name: 'Start recording' });
    expect(record).toHaveTextContent('Record');
    fireEvent.click(record);
    expect(onNewTake).toHaveBeenCalledTimes(1);
    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  // newTake dropped the host into the waiting room, losing the summary and
  // the take's sync.json with it.
  it('offers the invite link, and keeps the summary, when everyone else has left', async () => {
    const onNewTake = vi.fn();
    const onRecord = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <CallStage {...doneProps} remoteStream={null} remotePeers={[]} onNewTake={onNewTake} onRecord={onRecord} />
    );
    expect(screen.queryByRole('button', { name: 'Start recording' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }));
    expect(writeText).toHaveBeenCalledWith(`${location.origin}${location.pathname}`);
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeInTheDocument();
    expect(onNewTake).not.toHaveBeenCalled();
    expect(onRecord).not.toHaveBeenCalled();
    expect(screen.getByTestId('summary-column')).toBeInTheDocument();
  });

  // The summary holds the host's downloads; the bar only gives the verdict.
  it("keeps the host's status line to the verdict, with downloads named for the room and take", () => {
    render(<CallStage {...doneProps} />);
    const bar = screen.getByTestId('status-bar');
    expect(bar).toHaveTextContent('Saved — 2 files in your recording folder.');
    expect(bar.querySelector('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'Download sync.json' }).getAttribute('download')).toBe(
      'openmeet-abc-defg-hij-take2-sync.json'
    );
    expect(screen.getByRole('link', { name: 'Download your backup' }).getAttribute('download')).toBe(
      'openmeet-abc-defg-hij-take2-backup-alice.mp4'
    );
  });

  it('says saved with warnings when the take has any', () => {
    render(<CallStage {...doneProps} summary={{ ...summary, warnings: ['Bob: no WAV master'] }} />);
    expect(screen.getByTestId('status-bar')).toHaveTextContent('Saved with warnings — 2 files in your recording folder.');
  });

  // Leave mid-save started a second finalize and tore down the connections the
  // guests' last seconds were still arriving on.
  it('says to keep the tab open while saving, and holds Leave until it finishes', () => {
    const onLeave = vi.fn();
    render(<CallStage {...baseProps} phase="finalizing" finalizingGuests={['Bob']} onLeave={onLeave} />);
    // Announced by the status bar, a live region that is always mounted; the
    // toast mounts with its text, which many screen readers skip.
    expect(screen.getByTestId('status-bar')).toHaveTextContent(
      /getting the last few seconds from Bob\. Keep this tab open\./
    );
    expect(screen.getAllByText(/Keep this tab open/).filter((el) => !el.closest('[aria-hidden]'))).toHaveLength(1);
    const leave = screen.getByRole('button', { name: /^Leave call/ });
    expect(leave).toBeDisabled();
    fireEvent.click(leave);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('tells a saving guest to keep the tab open too', () => {
    render(<CallStage {...baseProps} role="guest" phase="finalizing" />);
    expect(screen.getByTestId('status-bar')).toHaveTextContent(
      'Sending your last few seconds to the host. Keep this tab open.'
    );
  });

  it.each(['host', 'guest'] as const)('shows the %s how long the take has been running', (role) => {
    vi.useFakeTimers();
    try {
      render(<CallStage {...baseProps} role={role} phase="recording" />);
      expect(screen.getByRole('timer')).toHaveTextContent('0:00');
      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(screen.getByRole('timer')).toHaveTextContent('1:05');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallStage media board', () => {
  // Only the take running when the board is first opened misses the pads.
  it('says the pads miss this take only when the board is first opened mid-take', () => {
    const { rerender } = render(<CallStage {...baseProps} phase="recording" />);
    fireEvent.click(screen.getByRole('button', { name: 'Media board' }));
    expect(screen.getByText(/This take keeps your mic only/)).toBeInTheDocument();

    rerender(<CallStage {...baseProps} phase="finalizing" />);
    expect(screen.queryByText(/This take keeps your mic only/)).toBeNull();
  });

  it('says nothing about it when opened between takes', () => {
    render(<CallStage {...baseProps} phase="in-call" />);
    fireEvent.click(screen.getByRole('button', { name: 'Media board' }));
    expect(screen.getByText(/Load intros, stingers or ad reads/)).toBeInTheDocument();
    expect(screen.queryByText(/This take keeps your mic only/)).toBeNull();
  });
});

describe('CallStage keep-up notice', () => {
  it('says so when the device stops keeping up during a take', async () => {
    vi.useFakeTimers();
    try {
      let lost = 0;
      const readLoad = vi.fn(async () => ({ audioDroppedMs: (lost += 150), cpuLimited: false }));
      render(<CallStage {...baseProps} phase="recording" readLoad={readLoad} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      const text = screen.getByText(
        'This device is struggling to keep up, so the recording may skip. Close other apps and tabs.'
      );
      expect(text).toBeInTheDocument();
      expect(text.closest('[role="status"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['in-call', 'finalizing'] as const)(
    'does not read or warn outside a take (%s)',
    async (phase) => {
      vi.useFakeTimers();
      try {
        let lost = 0;
        const readLoad = vi.fn(async () => ({ audioDroppedMs: (lost += 150), cpuLimited: false }));
        render(<CallStage {...baseProps} phase={phase} readLoad={readLoad} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(readLoad).not.toHaveBeenCalled();
        expect(
          screen.queryByText(
            'This device is struggling to keep up, so the recording may skip. Close other apps and tabs.'
          )
        ).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('offers low-power mode when the device is struggling', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.fn();
      let lost = 0;
      const readLoad = vi.fn(async () => ({ audioDroppedMs: (lost += 150), cpuLimited: false }));
      const onToggleCam = vi.fn();
      render(<CallStage {...baseProps} phase="recording" onSetLowPower={spy} onToggleCam={onToggleCam} readLoad={readLoad} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(
        screen.getByText(
          'This device is struggling to keep up, so the recording may skip. Close other apps and tabs.'
        )
      ).toBeInTheDocument();
      const btn = screen.getByRole('button', { name: 'Turn on low-power mode' });
      expect(btn).toHaveAttribute('type', 'button');
      fireEvent.click(btn);
      expect(spy).toHaveBeenCalledWith(true);
      expect(onToggleCam).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the mode is on, between takes too, and turns it off', () => {
    const spy = vi.fn();
    render(<CallStage {...baseProps} phase="in-call" lowPower onSetLowPower={spy} />);
    const text = screen.getByText(
      'Low-power mode is on: the others see you in lower quality. Your recording is unchanged.'
    );
    expect(text.closest('[role="status"]')).not.toBeNull();
    const btn = screen.getByRole('button', { name: 'Turn off low-power mode' });
    fireEvent.click(btn);
    expect(spy).toHaveBeenCalledWith(false);
  });

  it.each(['in-call', 'finalizing', 'done'] as const)(
    'says the mode is on outside a take (%s)',
    (phase) => {
      render(<CallStage {...baseProps} phase={phase} lowPower />);
      expect(
        screen.getByText(
          'Low-power mode is on: the others see you in lower quality. Your recording is unchanged.'
        )
      ).toBeInTheDocument();
    }
  );

  it('says what is left when low-power mode was not enough', async () => {
    vi.useFakeTimers();
    try {
      let lost = 0;
      const readLoad = vi.fn(async () => ({ audioDroppedMs: (lost += 150), cpuLimited: false }));
      render(<CallStage {...baseProps} phase="recording" lowPower readLoad={readLoad} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(
        screen.getByText(
          'Low-power mode is on, but this device is still struggling. Turn your camera off to protect the audio, and pick a lower quality before you join next time.'
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Turn off low-power mode' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the camera alone when the mode is turned off while still struggling', async () => {
    vi.useFakeTimers();
    try {
      let lost = 0;
      const readLoad = vi.fn(async () => ({ audioDroppedMs: (lost += 150), cpuLimited: false }));
      const onToggleCam = vi.fn();
      render(
        <CallStage
          {...baseProps}
          phase="recording"
          lowPower
          readLoad={readLoad}
          onToggleCam={onToggleCam}
          onSetLowPower={vi.fn()}
        />
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(
        screen.getByText(
          'Low-power mode is on, but this device is still struggling. Turn your camera off to protect the audio, and pick a lower quality before you join next time.'
        )
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Turn off low-power mode' }));
      expect(onToggleCam).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the earlier trouble once the mode is turned on', async () => {
    vi.useFakeTimers();
    try {
      let step = 150;
      let lost = 0;
      const readLoad = vi.fn(async () => ({ audioDroppedMs: (lost += step), cpuLimited: false }));
      const { rerender } = render(<CallStage {...baseProps} phase="recording" readLoad={readLoad} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(
        screen.getByText(
          'This device is struggling to keep up, so the recording may skip. Close other apps and tabs.'
        )
      ).toBeInTheDocument();
      const button = screen.getByRole('button', { name: 'Turn on low-power mode' });
      button.focus();

      step = 0;
      rerender(<CallStage {...baseProps} phase="recording" lowPower readLoad={readLoad} />);

      expect(
        screen.getByText(
          'Low-power mode is on: the others see you in lower quality. Your recording is unchanged.'
        )
      ).toBeInTheDocument();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Turn off low-power mode' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(
        screen.getByText(
          'Low-power mode is on: the others see you in lower quality. Your recording is unchanged.'
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByText(
          'Low-power mode is on, but this device is still struggling. Turn your camera off to protect the audio, and pick a lower quality before you join next time.'
        )
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes back to the plain sentence once the take is over', async () => {
    vi.useFakeTimers();
    try {
      let lost = 0;
      const readLoad = vi.fn(async () => ({ audioDroppedMs: (lost += 150), cpuLimited: false }));
      const { rerender } = render(<CallStage {...baseProps} phase="recording" lowPower readLoad={readLoad} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(
        screen.getByText(
          'Low-power mode is on, but this device is still struggling. Turn your camera off to protect the audio, and pick a lower quality before you join next time.'
        )
      ).toBeInTheDocument();
      rerender(<CallStage {...baseProps} phase="done" lowPower readLoad={readLoad} />);
      expect(
        screen.getByText(
          'Low-power mode is on: the others see you in lower quality. Your recording is unchanged.'
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByText(
          'Low-power mode is on, but this device is still struggling. Turn your camera off to protect the audio, and pick a lower quality before you join next time.'
        )
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallStage mic warning', () => {
  it('shows above the stage as an alert, in a call and in a take, and only when there is a warning', () => {
    const { unmount } = render(<CallStage {...baseProps} phase="in-call" micWarning="silent" />);
    const alertInCall = screen.getByRole('alert');
    expect(alertInCall.tagName).toBe('SPAN');
    expect(alertInCall).toHaveTextContent(MIC_WARNING_TEXT.silent);
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss microphone warning' });
    expect(dismissBtn).toHaveAttribute('type', 'button');
    expect(dismissBtn).toHaveTextContent('Dismiss');
    expect(alertInCall.contains(dismissBtn)).toBe(false);
    const pill = alertInCall.closest('div');
    expect(pill?.className).toContain('max-w-[92vw]');
    expect(pill?.className).toContain('text-[#fdd663]');
    const stageColInCall = screen.getByTestId('stage-column');
    expect(stageColInCall.contains(alertInCall)).toBe(false);
    expect(alertInCall.compareDocumentPosition(stageColInCall) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();

    const { unmount: unmountRec } = render(<CallStage {...baseProps} phase="recording" micWarning="silent" />);
    const alertRec = screen.getByRole('alert');
    expect(alertRec.tagName).toBe('SPAN');
    expect(alertRec).toHaveTextContent(MIC_WARNING_TEXT.silent);
    const stageColRec = screen.getByTestId('stage-column');
    expect(stageColRec.contains(alertRec)).toBe(false);
    expect(alertRec.compareDocumentPosition(stageColRec) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmountRec();

    render(<CallStage {...baseProps} phase="recording" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(MIC_WARNING_TEXT.silent)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss microphone warning' })).toBeNull();
  });

  it('dismiss outlasts the moment', () => {
    const { rerender } = render(<CallStage {...baseProps} phase="recording" micWarning="silent" />);
    expect(screen.getByRole('alert')).toHaveTextContent(MIC_WARNING_TEXT.silent);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss microphone warning' }));
    expect(screen.queryByText(MIC_WARNING_TEXT.silent)).toBeNull();

    rerender(<CallStage {...baseProps} phase="recording" micWarning={null} />);
    expect(screen.queryByText(MIC_WARNING_TEXT.silent)).toBeNull();

    rerender(<CallStage {...baseProps} phase="recording" micWarning="silent" />);
    expect(screen.queryByText(MIC_WARNING_TEXT.silent)).toBeNull();
  });

  it('arms again when a new take starts, and shows beside a recording problem', () => {
    const { rerender } = render(<CallStage {...baseProps} phase="in-call" micWarning="silent" />);
    expect(screen.getByRole('alert')).toHaveTextContent(MIC_WARNING_TEXT.silent);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss microphone warning' }));
    expect(screen.queryByText(MIC_WARNING_TEXT.silent)).toBeNull();

    rerender(<CallStage {...baseProps} phase="recording" micWarning="silent" recordingError="Disk is full" />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent(MIC_WARNING_TEXT.silent);
    expect(alerts[1]).toHaveTextContent('Disk is full');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss microphone warning' }));
    expect(screen.queryByText(MIC_WARNING_TEXT.silent)).toBeNull();

    rerender(<CallStage {...baseProps} phase="finalizing" micWarning="silent" recordingError={null} />);
    expect(screen.queryByText(MIC_WARNING_TEXT.silent)).toBeNull();

    rerender(<CallStage {...baseProps} phase="done" micWarning="silent" recordingError={null} />);
    expect(screen.queryByText(MIC_WARNING_TEXT.silent)).toBeNull();

    rerender(<CallStage {...baseProps} phase="in-call" micWarning="silent" recordingError={null} />);
    expect(screen.queryByText(MIC_WARNING_TEXT.silent)).toBeNull();
  });

  it('does not gate the warning on role, micOn state, or phase', () => {
    const { unmount: unmountGuest } = render(
      <CallStage {...baseProps} role="guest" phase="in-call" micWarning="silent" />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(MIC_WARNING_TEXT.silent);
    unmountGuest();

    const disabledTrack = { kind: 'audio', enabled: false } as any;
    const stream = {
      getAudioTracks: () => [disabledTrack],
      getVideoTracks: () => [],
    } as any;
    const { unmount: unmountMuted } = render(
      <CallStage {...baseProps} localStream={stream} phase="in-call" micWarning="silent" />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(MIC_WARNING_TEXT.silent);
    unmountMuted();

    const { unmount: unmountFinalizing } = render(
      <CallStage {...baseProps} phase="finalizing" micWarning="silent" />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(MIC_WARNING_TEXT.silent);
    unmountFinalizing();

    const { unmount: unmountDone } = render(
      <CallStage {...baseProps} phase="done" micWarning="silent" />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(MIC_WARNING_TEXT.silent);
    unmountDone();
  });

  it('holds dismissal through a mic switch', async () => {
    const mockDevices: MediaDeviceInfo[] = [
      {
        deviceId: 'mic-default',
        kind: 'audioinput',
        label: 'Default Microphone',
        groupId: 'g1',
        toJSON: () => ({}),
      },
      {
        deviceId: 'mic-usb',
        kind: 'audioinput',
        label: 'USB Podcast Mic',
        groupId: 'g2',
        toJSON: () => ({}),
      },
    ];
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(mockDevices),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    const onSwitchMic = vi.fn().mockResolvedValue(undefined);
    render(
      <CallStage
        {...baseProps}
        phase="recording"
        micWarning="silent"
        onSwitchMic={onSwitchMic}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss microphone warning' }));
    expect(screen.queryByRole('alert')).toBeNull();

    const micArrow = screen.getByLabelText(/select microphone/i);
    await act(async () => {
      fireEvent.click(micArrow);
    });

    await waitFor(() => {
      expect(screen.getByText('USB Podcast Mic')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('USB Podcast Mic'));
    });
    expect(onSwitchMic).toHaveBeenCalledWith('mic-usb');

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('causes no extra render when a take starts with nothing dismissed', async () => {
    let commits = 0;
    const { rerender } = await act(async () =>
      render(
        <Profiler id="cs" onRender={() => { commits += 1; }}>
          <CallStage {...baseProps} phase="in-call" />
        </Profiler>
      )
    );
    commits = 0;
    await act(async () => {
      rerender(
        <Profiler id="cs" onRender={() => { commits += 1; }}>
          <CallStage {...baseProps} phase="recording" />
        </Profiler>
      );
    });
    expect(commits).toBe(1);
  });

  it('renders clipping note inside the role="alert" element', () => {
    render(<CallStage {...baseProps} micWarning="clipping" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(MIC_WARNING_TEXT.clipping);
  });

  it('keeps dismissal per kind so dismissing silent leaves clipping visible', () => {
    const { rerender } = render(<CallStage {...baseProps} micWarning="silent" />);
    expect(screen.getByRole('alert')).toHaveTextContent(MIC_WARNING_TEXT.silent);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss microphone warning' }));
    expect(screen.queryByRole('alert')).toBeNull();

    rerender(<CallStage {...baseProps} micWarning="clipping" />);
    expect(screen.getByRole('alert')).toHaveTextContent(MIC_WARNING_TEXT.clipping);
  });

  it('dismisses the clipping note and leaves the silent one armed', () => {
    const { rerender } = render(<CallStage {...baseProps} micWarning="clipping" />);
    expect(screen.getByRole('alert')).toHaveTextContent(MIC_WARNING_TEXT.clipping);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss microphone warning' }));
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<CallStage {...baseProps} micWarning="silent" />);
    expect(screen.getByRole('alert')).toHaveTextContent(MIC_WARNING_TEXT.silent);
  });
});

describe('CallStage track panel', () => {
  const read = () => [{ key: 'own:camera', track: 'camera' as const, bytes: 1_500_000 }];

  // Against the call screen the panel would be positioned against the whole
  // viewport and land off the bottom of it; the status bar is its anchor.
  it('mounts the track panel inside a status bar it is positioned against', () => {
    render(<CallStage {...baseProps} phase="recording" markerCount={2} readTrackHealth={read} />);
    const bar = screen.getByTestId('status-bar');
    expect(bar.contains(screen.getByTestId('track-health'))).toBe(true);
    expect(bar.className).toMatch(/\brelative\b/);
    expect(screen.getByText('2 markers').nextElementSibling).toBe(screen.getByTestId('track-health'));
  });

  it('mounts the track panel for a guest whose own capture is running', () => {
    render(<CallStage {...baseProps} role="guest" phase="recording" readTrackHealth={read} />);
    expect(screen.getByTestId('track-health')).toBeTruthy();
  });

  // The panel is positioned against the status bar and paints over the
  // in-flow notices, so a banner only wins the stack by its own positioning.
  it('keeps an alert banner above an open track panel', () => {
    render(
      <CallStage
        {...baseProps}
        phase="recording"
        recordingError="The disk is full. Press End & save."
        readTrackHealth={read}
      />
    );
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('The disk is full. Press End & save.');
    expect(banner.className).toMatch(/\brelative\b/);
    expect(banner.className).toMatch(/\bz-50\b/);
  });

  it('leaves the track panel unmounted while the room records and this browser does not', () => {
    render(<CallStage {...baseProps} phase="in-call" roomRecording readTrackHealth={read} />);
    expect(screen.queryByTestId('track-health')).toBeNull();
  });

  it.each(['in-call', 'finalizing', 'done'] as const)(
    'leaves the track panel unmounted outside a take (%s)',
    (phase) => {
      render(<CallStage {...baseProps} phase={phase} readTrackHealth={read} />);
      expect(screen.queryByTestId('track-health')).toBeNull();
    }
  );

  // The element is absent either way (the panel itself skips a failed read), so
  // the only trace of a panel mounted without a reading is its armed timer.
  it('arms no timer for a panel that has nothing to read', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    try {
      const bare = render(<CallStage {...baseProps} phase="recording" />);
      const elapsedOnly = spy.mock.calls.length;
      bare.unmount();
      spy.mockClear();

      const withRead = render(<CallStage {...baseProps} phase="recording" readTrackHealth={read} />);
      expect(spy.mock.calls.length).toBe(elapsedOnly + 1);
      withRead.unmount();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('returned backups', () => {
  const offered = [
    {
      id: 'backup_asha_camera_20231114T221320000Z.mp4',
      kind: 'camera' as const,
      size: 1_500_000_000,
      status: 'offered' as const,
      percent: 0,
      from: 'Asha',
    },
  ];

  // The notice must sit in the flow above the stage, where it cannot cover the
  // Recording pill, a name tag or the PiP.
  it('shows an offer above the stage and saves it from the button', () => {
    const onAcceptBackups = vi.fn();
    render(
      <CallStage {...baseProps} backupTransfers={offered} onAcceptBackups={onAcceptBackups} />
    );

    const notice = screen.getByText(
      'Asha wants to send you 1 backup file (1.5 GB) from an earlier recording in this room.'
    );
    const column = screen.getByTestId('stage-column');
    expect(
      column.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save to folder' }));
    expect(onAcceptBackups).toHaveBeenCalledTimes(1);
  });

  it('hands a stalled backup to the engine when the host dismisses it', () => {
    const onDismissBackup = vi.fn();
    const stalled = offered.map((t) => ({ ...t, status: 'stalled' as const, percent: 30 }));
    render(
      <CallStage {...baseProps} backupTransfers={stalled} onDismissBackup={onDismissBackup} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissBackup).toHaveBeenCalledWith(stalled[0]!.id);
  });

  it('holds an offer back while a take records', () => {
    render(
      <CallStage
        {...baseProps}
        phase="recording"
        backupTransfers={offered}
        onAcceptBackups={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Save to folder' })).toBeNull();
    expect(screen.queryByText(/wants to send you/)).toBeNull();
  });

  it('shows a guest its own backup, without the host’s buttons', () => {
    render(<CallStage {...baseProps} role="guest" backupTransfers={offered} />);
    expect(
      screen.getByText('Waiting for the host to accept your backup (1 file, 1.5 GB). Keep this tab open.')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save to folder' })).toBeNull();
  });

  it('lets the host decline an offer from the notice', () => {
    const onDeclineBackups = vi.fn();
    render(
      <CallStage {...baseProps} backupTransfers={offered} onDeclineBackups={onDeclineBackups} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDeclineBackups).toHaveBeenCalledTimes(1);
  });
});

describe('interrupted take notice', () => {
  it('offers to continue the same take and to save what was recorded', () => {
    const onResumeRecording = vi.fn();
    const onSaveRecording = vi.fn();
    render(
      <CallStage
        {...baseProps}
        resumeOffer={{ take: 1, canResume: true }}
        onResumeRecording={onResumeRecording}
        onSaveRecording={onSaveRecording}
      />
    );

    const notice = screen
      .getByText('Recording was interrupted. This browser still has the take.')
      .closest('[role="status"]');
    expect(notice).not.toBeNull();
    fireEvent.click(within(notice as HTMLElement).getByRole('button', { name: 'Resume recording' }));
    fireEvent.click(within(notice as HTMLElement).getByRole('button', { name: 'Save what was recorded' }));
    expect(onResumeRecording).toHaveBeenCalledTimes(1);
    expect(onSaveRecording).toHaveBeenCalledTimes(1);
  });

  // The offer only appears when a pending channel would really continue a file,
  // so with none there is one action, not a dead button.
  it('offers only to save when nothing pending would continue the take', () => {
    render(<CallStage {...baseProps} resumeOffer={{ take: 1, canResume: false }} />);

    expect(
      screen.getByText('Recording was interrupted. This browser still has the take.')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume recording' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save what was recorded' })).toBeTruthy();
  });

  it('lets neither action, nor Record, be pressed while a resume or a save runs', () => {
    const onResumeRecording = vi.fn();
    const onSaveRecording = vi.fn();
    const onRecord = vi.fn();
    render(
      <CallStage
        {...baseProps}
        onRecord={onRecord}
        resumeOffer={{ take: 1, canResume: true }}
        onResumeRecording={onResumeRecording}
        onSaveRecording={onSaveRecording}
        recoveryBusy
      />
    );

    const resume = screen.getByRole('button', { name: 'Resume recording' });
    const save = screen.getByRole('button', { name: 'Save what was recorded' });
    const record = screen.getByRole('button', { name: 'Start recording' });
    for (const button of [resume, save, record]) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onResumeRecording).not.toHaveBeenCalled();
    expect(onSaveRecording).not.toHaveBeenCalled();
    expect(onRecord).not.toHaveBeenCalled();
    expect(resume.closest('[role="status"]')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows no notice when no take was interrupted', () => {
    render(<CallStage {...baseProps} />);

    expect(
      screen.queryByText('Recording was interrupted. This browser still has the take.')
    ).toBeNull();
    expect(screen.queryByText('Save what was recorded')).toBeNull();
  });

  it('reports a take saved from inside the call as a status line', () => {
    render(<CallStage {...baseProps} takeNotice="Saved 1 file to your folder." />);

    expect(screen.getByText('Saved 1 file to your folder.').getAttribute('role')).toBe('status');
    expect(screen.queryByText('Recording was interrupted. This browser still has the take.')).toBeNull();
  });
});

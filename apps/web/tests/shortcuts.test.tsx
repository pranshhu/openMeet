import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';
import { ControlButton } from '@/components/ControlButton';
import { Shortcuts } from '@/components/Shortcuts';

const callProps = {
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

/** One key press, on the page itself unless a field is given. False when the press was taken. */
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, ...init });

describe('Shortcuts', () => {
  it('presses the button that carries the letter, for the bare letter only', () => {
    const onClick = vi.fn();
    render(
      <>
        <Shortcuts />
        <ControlButton icon="mic" label="Turn off microphone" shortcut="A" onClick={onClick} />
      </>
    );
    // Taken, so the letter is not typed into whatever the button opens.
    expect(press('a')).toBe(false);
    press('A'); // Caps Lock
    expect(onClick).toHaveBeenCalledTimes(2);

    press('a', { repeat: true });
    press('a', { ctrlKey: true });
    press('a', { metaKey: true });
    press('a', { altKey: true });
    press('A', { shiftKey: true });
    // A letter no button carries is left to the browser.
    expect(press('x')).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('takes letters only, so no key can break the lookup', () => {
    const onClick = vi.fn();
    render(
      <>
        <Shortcuts />
        <ControlButton icon="mic" label="One" shortcut="1" onClick={onClick} />
      </>
    );
    press('1');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does nothing while the person types in a field', () => {
    const onClick = vi.fn();
    render(
      <>
        <Shortcuts />
        <ControlButton icon="mic" label="Turn off microphone" shortcut="A" onClick={onClick} />
        <input aria-label="Message" />
        <textarea aria-label="Script" />
        <select aria-label="Device">
          <option>Built-in</option>
        </select>
        <div aria-label="Note" contentEditable suppressContentEditableWarning>
          note
        </div>
      </>
    );
    for (const field of ['Message', 'Script', 'Device', 'Note']) {
      press('a', {}, screen.getByLabelText(field));
      press('?', { shiftKey: true }, screen.getByLabelText(field));
    }
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByText('Microphone on or off')).toBeNull();
  });

  it('cannot press a button that is disabled', () => {
    const onClick = vi.fn();
    render(
      <>
        <Shortcuts />
        <ControlButton icon="record" label="Start recording" shortcut="A" disabled onClick={onClick} />
      </>
    );
    press('a');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('cannot press a button that is not shown', () => {
    const onClick = vi.fn();
    render(
      <>
        <Shortcuts />
        <ControlButton icon="mic" label="Turn off microphone" shortcut="A" onClick={onClick} />
      </>
    );
    // jsdom has no layout, so the browser's answer is given here: a narrow
    // window hides the control bar while chat or the summary covers the stage.
    screen.getByRole('button', { name: 'Turn off microphone' }).checkVisibility = () => false;
    // Not taken either: nothing was pressed, so the key is left to the browser.
    expect(press('a')).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('lists the keys behind its button and the ? key, and Escape puts the list away', () => {
    render(<Shortcuts />);
    const button = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Microphone on or off')).toBeNull();

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    for (const [keys, does] of [
      ['A', 'Microphone on or off'],
      ['V', 'Camera on or off'],
      ['C', 'Chat'],
      ['T', 'Teleprompter'],
      ['M', 'Marker, while recording'],
      ['?', 'This list'],
    ] as const) {
      expect(screen.getByText(does).previousElementSibling).toHaveTextContent(keys);
    }
    expect(screen.getByText(/Keys do nothing while you type in a field/)).toBeInTheDocument();

    press('Escape');
    expect(screen.queryByText('Microphone on or off')).toBeNull();
    press('?', { shiftKey: true });
    expect(screen.getByText('Microphone on or off')).toBeInTheDocument();
    press('?', { shiftKey: true });
    expect(screen.queryByText('Microphone on or off')).toBeNull();
  });
});

describe('CallStage: shortcut keys', () => {
  it('A and V press the microphone and camera buttons', () => {
    const onToggleMic = vi.fn();
    const onToggleCam = vi.fn();
    render(<CallStage {...callProps} onToggleMic={onToggleMic} onToggleCam={onToggleCam} />);

    press('a');
    expect(onToggleMic).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Turn on microphone' })).toBeInTheDocument();
    press('a');
    expect(onToggleMic).toHaveBeenLastCalledWith(true);

    press('v');
    expect(onToggleCam).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Turn on camera' })).toBeInTheDocument();
  });

  it('C opens and closes chat, and T shows and hides the teleprompter', () => {
    render(<CallStage {...callProps} />);
    press('c');
    expect(screen.getByTestId('chat-column')).toBeInTheDocument();
    press('c');
    expect(screen.queryByTestId('chat-column')).toBeNull();

    press('t');
    expect(screen.getByRole('button', { name: 'Hide teleprompter' })).toBeInTheDocument();
    press('t');
    expect(screen.getByRole('button', { name: 'Show teleprompter' })).toBeInTheDocument();
  });

  it('leaves the chat field and the teleprompter script alone', () => {
    const onToggleMic = vi.fn();
    render(<CallStage {...callProps} onToggleMic={onToggleMic} />);
    press('c');
    press('t');
    for (const field of ['Message', 'Teleprompter script']) {
      for (const key of ['a', 'c', 't']) press(key, {}, screen.getByLabelText(field));
    }
    expect(onToggleMic).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-column')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide teleprompter' })).toBeInTheDocument();
  });

  it('names each key in its button’s tooltip and leaves the accessible name as it was', () => {
    render(<CallStage {...callProps} />);
    for (const [name, key] of [
      ['Turn off microphone', 'A'],
      ['Turn off camera', 'V'],
      ['Chat', 'C'],
      ['Show teleprompter', 'T'],
    ] as const) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveAttribute('aria-keyshortcuts', key);
      expect(button).toHaveAttribute('title', `${name} (${key})`);
    }
    const leave = screen.getByRole('button', { name: 'Leave call' });
    expect(leave).toHaveAttribute('title', 'Leave call');
    expect(leave).not.toHaveAttribute('aria-keyshortcuts');
  });

  it('gives no microphone or camera key to a producer or a present-only device', () => {
    const onToggleMic = vi.fn();
    const onToggleCam = vi.fn();
    const { unmount } = render(
      <CallStage {...callProps} role="producer" canRecord={false} onToggleMic={onToggleMic} onToggleCam={onToggleCam} />
    );
    expect(press('a')).toBe(true);
    press('v');
    unmount();
    render(<CallStage {...callProps} companion onToggleMic={onToggleMic} onToggleCam={onToggleCam} />);
    press('a');
    press('v');
    press('t');
    expect(onToggleMic).not.toHaveBeenCalled();
    expect(onToggleCam).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Hide teleprompter' })).toBeNull();
  });

  it('offers the list from the status bar', () => {
    render(<CallStage {...callProps} />);
    const button = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    expect(screen.getByTestId('status-bar').contains(button)).toBe(true);
    // A phone's top bar has no room for it.
    expect(button.parentElement).toHaveClass('hidden', 'sm:block');
    press('?', { shiftKey: true });
    expect(screen.getByText('Camera on or off')).toBeInTheDocument();
  });

  it('still drops one marker for M, not two', () => {
    const onMark = vi.fn();
    render(<CallStage {...callProps} phase="recording" onMark={onMark} />);
    press('m');
    expect(onMark).toHaveBeenCalledTimes(1);
  });
});

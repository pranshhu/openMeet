import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';
import { ControlButton } from '@/components/ControlButton';
import { Shortcuts } from '@/components/Shortcuts';
import { setSingleKeys, singleKeysOn } from '@/hooks/use-single-keys';

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
    press('a', { altKey: true, keyCode: 65 });
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
      ['← →', 'Previous or next slide'],
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

  it('does not open the list for a held ?, or for ? with Ctrl or Cmd', () => {
    render(<Shortcuts />);
    press('?', { shiftKey: true, repeat: true });
    press('?', { shiftKey: true, ctrlKey: true });
    press('?', { shiftKey: true, metaKey: true });
    expect(screen.queryByText('Microphone on or off')).toBeNull();
    press('?', { shiftKey: true });
    expect(screen.getByText('Microphone on or off')).toBeInTheDocument();
  });

  it('keeps the list out of what the status bar announces', () => {
    render(<Shortcuts />);
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(screen.getByText('Keyboard shortcuts').parentElement).toHaveAttribute('aria-live', 'off');
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

describe('CallStage: Alt+R starts a take and Alt+S ends it', () => {
  /** Alt with one letter, as a keyboard that types the letter itself sends it. */
  const alt = (letter: 'r' | 's', init: KeyboardEventInit = {}, target: Element = document.body) =>
    press(
      letter,
      { code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0), altKey: true, ...init },
      target
    );

  it('Alt+R presses Record for the host, and Alt+S presses End & save once the take runs', () => {
    const onRecord = vi.fn();
    const onEnd = vi.fn();
    const { rerender } = render(<CallStage {...callProps} onRecord={onRecord} onEnd={onEnd} />);
    expect(screen.getByRole('button', { name: 'Start recording' })).toHaveAttribute(
      'title',
      'Start recording (Alt+R)'
    );
    // No take runs: nothing carries Alt+S, so it is left to the browser.
    expect(alt('s')).toBe(true);
    // Taken, so the browser does nothing else with the chord.
    expect(alt('r')).toBe(false);
    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();

    rerender(<CallStage {...callProps} phase="recording" roomRecording onRecord={onRecord} onEnd={onEnd} />);
    // The key that starts a take can never end it.
    alt('r');
    expect(onEnd).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'End & save recording' })).toHaveAttribute(
      'title',
      'End & save recording (Alt+S)'
    );
    expect(alt('s')).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  it('reads the letter from the key code when Option has turned it into a symbol', () => {
    const onRecord = vi.fn();
    const onEnd = vi.fn();
    const { rerender } = render(<CallStage {...callProps} onRecord={onRecord} onEnd={onEnd} />);
    press('®', { code: 'KeyR', keyCode: 82, altKey: true });
    expect(onRecord).toHaveBeenCalledTimes(1);

    rerender(<CallStage {...callProps} phase="recording" roomRecording onRecord={onRecord} onEnd={onEnd} />);
    press('ß', { code: 'KeyS', keyCode: 83, altKey: true });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('is those chords alone: a bare letter, Shift, Ctrl, Cmd and a held chord press nothing', () => {
    const onRecord = vi.fn();
    const onEnd = vi.fn();
    const others = (letter: 'r' | 's') => {
      const code = `Key${letter.toUpperCase()}`;
      press(letter, { code });
      press(letter.toUpperCase(), { code, shiftKey: true });
      alt(letter, { shiftKey: true });
      alt(letter, { ctrlKey: true });
      alt(letter, { metaKey: true });
      alt(letter, { repeat: true });
    };
    const { rerender } = render(<CallStage {...callProps} onRecord={onRecord} onEnd={onEnd} />);
    others('r');
    rerender(<CallStage {...callProps} phase="recording" roomRecording onRecord={onRecord} onEnd={onEnd} />);
    others('s');
    expect(onRecord).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('cannot start a take while Record is greyed out, or from a field', () => {
    const onRecord = vi.fn();
    const { rerender } = render(
      <CallStage {...callProps} onRecord={onRecord} countdownEndsAt={Date.now() + 3000} />
    );
    alt('r');
    rerender(<CallStage {...callProps} onRecord={onRecord} recoveryBusy />);
    alt('r');
    rerender(<CallStage {...callProps} onRecord={onRecord} />);
    press('c');
    alt('r', {}, screen.getByLabelText('Message'));
    expect(onRecord).not.toHaveBeenCalled();
  });

  it('does nothing for a guest, and nothing while the take is being saved', () => {
    const onRecord = vi.fn();
    const onEnd = vi.fn();
    const { rerender } = render(
      <CallStage {...callProps} role="guest" canRecord={false} onRecord={onRecord} onEnd={onEnd} />
    );
    // Not taken: with no button to press, the chord is left to the browser.
    expect(alt('r')).toBe(true);
    rerender(
      <CallStage
        {...callProps}
        role="guest"
        canRecord={false}
        phase="recording"
        roomRecording
        onRecord={onRecord}
        onEnd={onEnd}
      />
    );
    alt('r');
    alt('s');
    rerender(<CallStage {...callProps} phase="finalizing" onRecord={onRecord} onEnd={onEnd} />);
    alt('r');
    alt('s');
    expect(onRecord).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('finds a chord by the letter the keyboard has on the key, not by the key’s place', () => {
    const onRecord = vi.fn();
    const onEnd = vi.fn();
    const { rerender } = render(<CallStage {...callProps} onRecord={onRecord} onEnd={onEnd} />);
    // Colemak has R on the key QWERTY calls S; on a Mac, Option types a symbol there.
    press('r', { code: 'KeyS', keyCode: 82, altKey: true });
    press('®', { code: 'KeyS', keyCode: 82, altKey: true });
    // A keyboard without Latin letters: the browser reports the letter of the key's place.
    press('к', { code: 'KeyR', keyCode: 82, altKey: true });
    expect(onRecord).toHaveBeenCalledTimes(3);

    rerender(<CallStage {...callProps} phase="recording" roomRecording onRecord={onRecord} onEnd={onEnd} />);
    // The key that starts a take never ends one, wherever the layout puts it.
    press('r', { code: 'KeyS', keyCode: 82, altKey: true });
    press('®', { code: 'KeyS', keyCode: 82, altKey: true });
    expect(onEnd).not.toHaveBeenCalled();
    // Colemak's S, on the key QWERTY calls D.
    press('ß', { code: 'KeyD', keyCode: 83, altKey: true });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onRecord).toHaveBeenCalledTimes(3);
  });

  it('does not take a function key for a letter', () => {
    const onRecord = vi.fn();
    const onEnd = vi.fn();
    const { rerender } = render(<CallStage {...callProps} onRecord={onRecord} onEnd={onEnd} />);
    // F3 has key code 114, a lower-case r, and F4 has 115, a lower-case s.
    press('F3', { code: 'F3', keyCode: 114, altKey: true });
    press('r', { code: 'KeyR', keyCode: 82, altKey: true });
    expect(onRecord).toHaveBeenCalledTimes(1);
    rerender(<CallStage {...callProps} phase="recording" roomRecording onRecord={onRecord} onEnd={onEnd} />);
    press('F4', { code: 'F4', keyCode: 115, altKey: true });
    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('lists both chords, and Alt with ? is not the key that opens the list', () => {
    render(<Shortcuts />);
    press('?', { shiftKey: true, altKey: true });
    expect(screen.queryByText('Keyboard shortcuts')).toBeNull();
    press('?', { shiftKey: true });
    expect(screen.getByText('Record (host)').previousElementSibling).toHaveTextContent('Alt+R');
    expect(screen.getByText('End & save (host)').previousElementSibling).toHaveTextContent('Alt+S');
    expect(screen.getByText(/On a Mac, Alt is the Option key/)).toBeInTheDocument();
  });
});

describe('Shortcuts: the switch for the single keys', () => {
  const off = () =>
    act(() => {
      setSingleKeys(false);
    });
  const on = () =>
    act(() => {
      setSingleKeys(true);
    });

  afterEach(() => {
    // What is still on screen shows the choice, so the reset is an update.
    on();
    localStorage.removeItem('om_single_keys');
  });

  it('lists N, the marker with a note, after M', () => {
    render(<Shortcuts />);
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    const does = screen.getByText('Marker with a note, while recording');
    expect(does.previousElementSibling).toHaveTextContent('N');
    expect(does.parentElement!.previousElementSibling).toHaveTextContent('Marker, while recording');
  });

  it('switched off, no single key presses a button or opens the list, and none is taken', () => {
    const onClick = vi.fn();
    render(
      <>
        <Shortcuts />
        {/* A plain button, so the rule under test is the listener's own. */}
        <button type="button" aria-keyshortcuts="A" onClick={onClick}>
          Microphone
        </button>
      </>
    );
    off();
    // true: not cancelled, so the letter is left to the browser.
    expect(press('a')).toBe(true);
    press('A');
    press('?', { shiftKey: true });
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByText('Microphone on or off')).toBeNull();

    // In force for the very next key, both ways: nothing is mounted again.
    on();
    expect(press('a')).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(1);
    press('?', { shiftKey: true });
    expect(screen.getByText('Microphone on or off')).toBeInTheDocument();
  });

  it('switched off, Alt+R and Alt+S still press their buttons', () => {
    const onRecord = vi.fn();
    const onEnd = vi.fn();
    off();
    const { rerender } = render(<CallStage {...callProps} onRecord={onRecord} onEnd={onEnd} />);
    expect(press('r', { code: 'KeyR', keyCode: 82, altKey: true })).toBe(false);
    expect(onRecord).toHaveBeenCalledTimes(1);
    rerender(<CallStage {...callProps} phase="recording" roomRecording onRecord={onRecord} onEnd={onEnd} />);
    press('s', { code: 'KeyS', keyCode: 83, altKey: true });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('switched off, A, V, C, T, M and N do nothing in a take, and their buttons still work', () => {
    const onToggleMic = vi.fn();
    const onToggleCam = vi.fn();
    const onMark = vi.fn();
    off();
    render(
      <CallStage
        {...callProps}
        phase="recording"
        roomRecording
        onToggleMic={onToggleMic}
        onToggleCam={onToggleCam}
        onMark={onMark}
      />
    );
    const note = () => screen.queryByLabelText('Note for this marker');
    for (const key of ['a', 'v', 'c', 't', 'm', 'M', 'N']) press(key);
    // true: not cancelled, so the letter is left to the browser.
    expect(press('n')).toBe(true);
    expect(onToggleMic).not.toHaveBeenCalled();
    expect(onToggleCam).not.toHaveBeenCalled();
    expect(onMark).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-column')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show teleprompter' })).toBeInTheDocument();
    expect(note()).toBeNull();

    // Only the keys are off.
    fireEvent.click(screen.getByRole('button', { name: /^Mark this moment/ }));
    expect(onMark).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /^Mark with a note/ }));
    expect(note()).not.toBeNull();
    fireEvent.keyDown(note()!, { key: 'Escape' });
    expect(note()).toBeNull();

    // Switched on in the middle of the take, M and N work for the very next key.
    on();
    press('m');
    expect(onMark).toHaveBeenCalledTimes(2);
    expect(press('n')).toBe(false);
    expect(note()).not.toBeNull();
  });

  it('offers the switch in the list: a ticked box in a row tall enough for a thumb', () => {
    render(<Shortcuts />);
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    const box = screen.getByRole('checkbox', { name: 'Single-key shortcuts' });
    expect(box).toBeChecked();
    expect(box.closest('label')).toHaveClass('min-h-11');

    fireEvent.click(box);
    expect(box).not.toBeChecked();
    expect(singleKeysOn()).toBe(false);
    expect(localStorage.getItem('om_single_keys')).toBe('0');
    // The list is still there to turn them on again.
    expect(screen.getByText('Microphone on or off')).toBeInTheDocument();

    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(singleKeysOn()).toBe(true);
  });

  it('switched off, the list still opens from its button and Escape puts it away', () => {
    off();
    render(<Shortcuts />);
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(screen.getByRole('checkbox', { name: 'Single-key shortcuts' })).not.toBeChecked();
    press('Escape');
    expect(screen.queryByText('Microphone on or off')).toBeNull();
  });

  it('Escape on the box closes the list and hands focus back to the ? button, and takes focus from nothing else', () => {
    render(
      <>
        <Shortcuts />
        <input aria-label="Message" />
      </>
    );
    const button = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    fireEvent.click(button);
    const box = screen.getByRole('checkbox', { name: 'Single-key shortcuts' });
    box.focus();
    expect(box).toHaveFocus();
    press('Escape', {}, box);
    expect(screen.queryByText('Microphone on or off')).toBeNull();
    expect(button).toHaveFocus();

    // Escape pressed with the keyboard anywhere else leaves it where it is.
    fireEvent.click(button);
    const field = screen.getByLabelText('Message');
    field.focus();
    press('Escape', {}, field);
    expect(screen.queryByText('Microphone on or off')).toBeNull();
    expect(field).toHaveFocus();
  });

  it('switched off, no button names a single key, and the two chords keep theirs', () => {
    off();
    const { rerender } = render(<CallStage {...callProps} />);
    for (const name of ['Turn off microphone', 'Turn off camera', 'Chat', 'Show teleprompter']) {
      const button = screen.getByRole('button', { name });
      expect(button).not.toHaveAttribute('aria-keyshortcuts');
      expect(button).toHaveAttribute('title', name);
    }
    const record = screen.getByRole('button', { name: 'Start recording' });
    expect(record).toHaveAttribute('aria-keyshortcuts', 'Alt+R');
    expect(record).toHaveAttribute('title', 'Start recording (Alt+R)');

    rerender(<CallStage {...callProps} phase="recording" roomRecording markerCount={2} />);
    expect(screen.getByRole('button', { name: 'End & save recording' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Alt+S'
    );
    // The whole name is matched: neither holds a key.
    expect(screen.getByRole('button', { name: 'Mark this moment — 2 so far' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark with a note' })).toBeInTheDocument();

    // Switched on, each button names its key again without being mounted again.
    on();
    const mic = screen.getByRole('button', { name: 'Turn off microphone' });
    expect(mic).toHaveAttribute('aria-keyshortcuts', 'A');
    expect(mic).toHaveAttribute('title', 'Turn off microphone (A)');
    expect(screen.getByRole('button', { name: 'Mark this moment (M) — 2 so far' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark with a note (N)' })).toBeInTheDocument();
  });

  it('a button follows the switch by itself: switched on again, its key is named and presses it', () => {
    const onClick = vi.fn();
    off();
    // Beside the list, under nothing that shows the choice: only the button's
    // own reading of it can draw the button again.
    render(
      <>
        <Shortcuts />
        <ControlButton icon="mic" label="Turn off microphone" shortcut="A" onClick={onClick} />
      </>
    );
    const button = screen.getByRole('button', { name: 'Turn off microphone' });
    expect(button).not.toHaveAttribute('aria-keyshortcuts');
    press('a');
    expect(onClick).not.toHaveBeenCalled();

    on();
    expect(button).toHaveAttribute('aria-keyshortcuts', 'A');
    expect(button).toHaveAttribute('title', 'Turn off microphone (A)');
    press('a');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('switched off, closing the note field still hands focus back to its button', async () => {
    off();
    render(<CallStage {...callProps} phase="recording" roomRecording />);
    const button = screen.getByRole('button', { name: 'Mark with a note' });
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByLabelText('Note for this marker'), { key: 'Escape' });
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('switched off, the list says so, dims the single keys and leaves the chords as they are', () => {
    off();
    render(<Shortcuts />);
    const button = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    expect(button).toHaveAttribute('title', 'Keyboard shortcuts');
    fireEvent.click(button);
    const said = 'Single keys are off. Alt+R and Alt+S stay on.';
    expect(screen.getByText(said)).toBeInTheDocument();
    const row = (does: string) => screen.getByText(does).parentElement!;
    for (const does of ['Microphone on or off', 'Marker with a note, while recording', 'This list']) {
      expect(row(does)).toHaveClass('opacity-60');
    }
    for (const does of ['Record (host)', 'End & save (host)', 'Previous or next slide']) expect(row(does)).not.toHaveClass('opacity-60');

    on();
    expect(screen.queryByText(said)).toBeNull();
    expect(row('Microphone on or off')).not.toHaveClass('opacity-60');
    expect(button).toHaveAttribute('title', 'Keyboard shortcuts (?)');
  });
});

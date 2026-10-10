import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CallStage } from '@/components/CallStage';
import { MAX_MARKER_LABEL_LENGTH } from '@/lib/sync-report';

const onMark = vi.fn();

// A take is running on this tab: the only time the marker controls are shown.
const props = {
  role: 'host' as const,
  phase: 'recording' as const,
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
  onMark,
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

const noteButton = () => screen.getByRole('button', { name: 'Mark with a note (N)' });
const field = () => screen.queryByLabelText('Note for this marker');

beforeEach(() => {
  onMark.mockClear();
});

describe('CallStage: a marker with a typed note', () => {
  it('adds a marker with the note, closes the field and hands focus back to its button', async () => {
    render(<CallStage {...props} />);
    fireEvent.click(noteButton());
    const input = field()!;
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('maxlength', String(MAX_MARKER_LABEL_LENGTH));

    fireEvent.change(input, { target: { value: '  great answer  ' } });
    fireEvent.submit(input.closest('form')!);

    expect(onMark).toHaveBeenCalledTimes(1);
    expect(onMark.mock.calls[0]![0]).toBe('great answer');
    expect(field()).toBeNull();
    await waitFor(() => expect(noteButton()).toHaveFocus());
  });

  it('adds nothing for an empty note, on Escape or from the close button, and opens empty again', () => {
    render(<CallStage {...props} />);
    fireEvent.click(noteButton());
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(field()!, { target: { value: '   ' } });
    fireEvent.submit(field()!.closest('form')!);
    expect(field()).not.toBeNull();

    fireEvent.change(field()!, { target: { value: 'half a thought' } });
    fireEvent.keyDown(field()!, { key: 'Escape' });
    expect(field()).toBeNull();

    fireEvent.click(noteButton());
    expect(field()).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Close note' }));
    expect(field()).toBeNull();
    expect(onMark).not.toHaveBeenCalled();
  });

  it('opens on N without typing the letter, and not with a modifier or while typing in chat', () => {
    render(<CallStage {...props} />);
    // false: the key was cancelled, so it is not typed into the field it opens.
    expect(fireEvent.keyDown(document.body, { key: 'n' })).toBe(false);
    expect(field()).toHaveFocus();
    fireEvent.keyDown(field()!, { key: 'Escape' });

    fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true });
    expect(field()).toBeNull();

    fireEvent.click(screen.getByLabelText('Chat'));
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'n' });
    expect(field()).toBeNull();
  });

  it('lets m and n be typed into the note without a marker or a cancelled key', () => {
    render(<CallStage {...props} />);
    fireEvent.click(noteButton());
    fireEvent.keyDown(field()!, { key: 'm' });
    expect(onMark).not.toHaveBeenCalled();
    // true: not cancelled, so the letter reaches the field.
    expect(fireEvent.keyDown(field()!, { key: 'n' })).toBe(true);
  });

  it('closes with the take and starts the next take closed', () => {
    const { rerender } = render(<CallStage {...props} />);
    fireEvent.click(noteButton());
    rerender(<CallStage {...props} phase="finalizing" />);
    expect(field()).toBeNull();
    rerender(<CallStage {...props} phase="recording" />);
    expect(field()).toBeNull();
    expect(onMark).not.toHaveBeenCalled();
  });

  it('offers nothing outside a take', () => {
    render(<CallStage {...props} phase="in-call" />);
    expect(screen.queryByRole('button', { name: 'Mark with a note (N)' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(field()).toBeNull();
  });

  it('is drawn under the recording notice, and leaves a phone screen with the control bar', () => {
    render(<CallStage {...props} role="guest" roomRecording />);
    fireEvent.click(noteButton());
    const band = field()!.closest('form')!.parentElement!;
    const notice = screen.getByRole('alert');
    expect(band.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(band).toHaveClass('top-3', 'flex');

    fireEvent.click(screen.getByLabelText('Chat'));
    expect(band).toHaveClass('hidden', 'sm:flex');
    expect(band).not.toHaveClass('flex');
  });

  it('lights the note button while the field is open, and a second press closes the field', () => {
    render(<CallStage {...props} />);
    expect(noteButton()).toHaveClass('bg-[#3c4043]');
    fireEvent.click(noteButton());
    expect(noteButton()).toHaveClass('bg-white');
    fireEvent.click(noteButton());
    expect(field()).toBeNull();
    expect(noteButton()).toHaveClass('bg-[#3c4043]');
  });

  it('gives the field and its close button the copy the design sets', () => {
    render(<CallStage {...props} />);
    fireEvent.click(noteButton());
    expect(screen.getByPlaceholderText('Note for this marker')).toBe(field());
    expect(screen.getByRole('button', { name: 'Close note' })).toHaveAttribute('title', 'Close note');
  });

  it('adds the note when its Add button is clicked', () => {
    render(<CallStage {...props} />);
    fireEvent.click(noteButton());
    fireEvent.change(field()!, { target: { value: 'cut this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onMark).toHaveBeenCalledWith('cut this', expect.any(Number));
    expect(field()).toBeNull();
  });

  it('lets clicks through the band except on the field itself', () => {
    render(<CallStage {...props} />);
    fireEvent.click(noteButton());
    const form = field()!.closest('form')!;
    expect(form.parentElement).toHaveClass('pointer-events-none');
    expect(form).toHaveClass('pointer-events-auto');
  });
});

describe('CallStage: a note marks the moment its field opened', () => {
  it('hands onMark the moment the field opened, not the moment of Enter', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      render(<CallStage {...props} />);
      fireEvent.click(noteButton());
      now.mockReturnValue(1_008_000);
      const input = field()!;
      fireEvent.change(input, { target: { value: 'great answer' } });
      fireEvent.submit(input.closest('form')!);
      expect(onMark).toHaveBeenCalledWith('great answer', 1_000_000);
    } finally {
      now.mockRestore();
    }
  });
});

describe('CallStage: the keys while typing elsewhere, and where the field sits', () => {
  it('ignores N and M typed into the teleprompter script or into editable text', () => {
    render(<CallStage {...props} />);
    // With no script saved for this room the teleprompter opens in its editor.
    fireEvent.click(screen.getByRole('button', { name: 'Show teleprompter' }));
    const script = screen.getByLabelText('Teleprompter script');
    expect(script.tagName).toBe('TEXTAREA');
    const editable = document.body.appendChild(document.createElement('div'));
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    try {
      for (const el of [script, editable]) {
        // true: not cancelled, so the letter reaches what is being typed in.
        expect(fireEvent.keyDown(el, { key: 'n' })).toBe(true);
        fireEvent.keyDown(el, { key: 'm' });
      }
      expect(field()).toBeNull();
      expect(onMark).not.toHaveBeenCalled();
    } finally {
      editable.remove();
    }
  });

  it('opens on a capital N, and not with the Meta or Alt key held', () => {
    render(<CallStage {...props} />);
    fireEvent.keyDown(document.body, { key: 'n', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'n', altKey: true });
    expect(field()).toBeNull();
    fireEvent.keyDown(document.body, { key: 'N' });
    expect(field()).toHaveFocus();
  });

  it('sits at the bottom of the stage on a computer while the teleprompter is open', () => {
    render(<CallStage {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show teleprompter' }));
    fireEvent.click(noteButton());
    const band = field()!.closest('form')!.parentElement!;
    expect(band).toHaveClass('top-3', 'sm:top-auto', 'sm:bottom-3');
  });
});

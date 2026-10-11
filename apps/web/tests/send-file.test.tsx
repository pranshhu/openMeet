import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SendFile } from '@/components/SendFile';
import { ChatPanel } from '@/components/ChatPanel';
import { MAX_SHARED_FILE_BYTES, SHARED_FILE_ACCEPT, sharedFileProblem } from '@/lib/shared-file';

const WRONG_TYPE = 'Only photos, documents, slides, audio and video can be sent.';
const EMPTY = 'That file is empty.';
const TOO_BIG = 'That file is over 100 MB, the most that can be sent.';

/** A file that says it is `size` bytes long, without holding them. */
function fileOf(name: string, size: number): File {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

const pick = (file: File) =>
  fireEvent.change(screen.getByLabelText('Send a file to the host'), { target: { files: [file] } });

describe('sharedFileProblem', () => {
  it('lets a listed type of up to the limit go', () => {
    expect(sharedFileProblem({ name: 'Headshot.JPG', size: 2_000_000 })).toBeNull();
    expect(sharedFileProblem({ name: 'deck.pptx', size: MAX_SHARED_FILE_BYTES })).toBeNull();
  });

  it('says why a file cannot go', () => {
    expect(sharedFileProblem({ name: 'setup.exe', size: 10 })).toBe(WRONG_TYPE);
    expect(sharedFileProblem({ name: 'bio.txt', size: 0 })).toBe(EMPTY);
    expect(sharedFileProblem({ name: 'talk.mp4', size: MAX_SHARED_FILE_BYTES + 1 })).toBe(TOO_BIG);
  });
});

describe('SendFile', () => {
  it('hands a file that can go to the caller, and says nothing', () => {
    const onSend = vi.fn();
    render(<SendFile onSend={onSend} />);
    const file = fileOf('Headshot.JPG', 2_000_000);
    pick(file);
    expect(onSend.mock.calls).toEqual([[file]]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    { name: 'setup.exe', size: 10, why: WRONG_TYPE },
    { name: 'page.html', size: 10, why: WRONG_TYPE },
    { name: 'bio.txt', size: 0, why: EMPTY },
    { name: 'talk.mp4', size: MAX_SHARED_FILE_BYTES + 1, why: TOO_BIG },
  ])('keeps $name on this device and says why', ({ name, size, why }) => {
    const onSend = vi.fn();
    render(<SendFile onSend={onSend} />);
    pick(fileOf(name, size));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(why);
  });

  it('drops the reason when the next file can go, and asks the picker for the listed types', () => {
    const onSend = vi.fn();
    render(<SendFile onSend={onSend} />);
    pick(fileOf('setup.exe', 10));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    pick(fileOf('bio.txt', 10));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onSend).toHaveBeenCalledTimes(1);

    expect(screen.getByLabelText('Send a file to the host')).toHaveAttribute('accept', SHARED_FILE_ACCEPT);
    expect(SHARED_FILE_ACCEPT.split(',')).toEqual(
      expect.arrayContaining(['.jpg', '.pdf', '.pptx', '.mp3', '.mp4'])
    );
    expect(SHARED_FILE_ACCEPT).not.toMatch(/exe|html|svg|zip/);
  });

  it('empties the picker after a pick, so the same file can be picked again', () => {
    render(<SendFile onSend={vi.fn()} />);
    const input = screen.getByLabelText('Send a file to the host') as HTMLInputElement;
    // jsdom keeps no real selection for a file that was set through the event, so the
    // setter is watched instead: a browser shows no change for the same file otherwise.
    const writes: string[] = [];
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => 'C:\\fakepath\\bio.txt',
      set: (v: string) => {
        writes.push(v);
      },
    });
    pick(fileOf('bio.txt', 10));
    expect(writes).toEqual(['']);
  });
});

describe('ChatPanel: send a file', () => {
  it('offers it only when it is given somewhere to send', () => {
    const { unmount } = render(<ChatPanel messages={[]} onSend={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('Send a file to the host')).toBeNull();
    unmount();

    const onSendFile = vi.fn();
    render(<ChatPanel messages={[]} onSend={vi.fn()} onClose={vi.fn()} onSendFile={onSendFile} />);
    const file = fileOf('bio.txt', 10);
    pick(file);
    expect(onSendFile.mock.calls).toEqual([[file]]);
    // The message box is still there, below it.
    expect(screen.getByLabelText('Message')).toBeInTheDocument();
  });
});

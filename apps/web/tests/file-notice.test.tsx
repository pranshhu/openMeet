import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FileNotice } from '@/components/FileNotice';
import { BackupNotice } from '@/components/BackupNotice';
import type { BackupTransfer } from '@/hooks/backup-return';

const file = (over: Partial<BackupTransfer> = {}): BackupTransfer => ({
  id: 'file-1',
  kind: 'file',
  size: 1_200_000,
  status: 'offered',
  percent: 0,
  from: 'Asha',
  name: 'shared_asha_headshot.jpg',
  ...over,
});

const backup: BackupTransfer = {
  id: 'openmeet-backup-1700000000000-abc-defg-hij.mp4',
  kind: 'camera',
  size: 5_000_000,
  status: 'offered',
  percent: 0,
  from: 'Asha',
};

/** The same file as its sender's page holds it: its own name, and no sender. */
function mine(over: Partial<BackupTransfer> = {}): BackupTransfer {
  const { from: _from, ...rest } = file({ name: 'Headshot.JPG', ...over });
  return rest;
}

function show(props: {
  role?: 'host' | 'guest';
  transfers: BackupTransfer[];
  takeActive?: boolean;
  onAccept?: (shown: BackupTransfer[]) => void;
  onDecline?: (shown: BackupTransfer[]) => void;
  onDismiss?: (id: string) => void;
  onStop?: (id: string) => void;
}) {
  return render(
    <FileNotice
      role={props.role ?? 'host'}
      transfers={props.transfers}
      takeActive={props.takeActive ?? false}
      onAccept={props.onAccept}
      onDecline={props.onDecline}
      onDismiss={props.onDismiss}
      onStop={props.onStop}
    />
  );
}

describe('FileNotice, on the host', () => {
  it('asks about the offered files by name and size, and hands each answer the files it showed', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const a = file();
    const b = file({ id: 'file-2', name: 'shared_asha_bio.txt', size: 800_000 });
    show({ transfers: [a, backup, b], onAccept, onDecline });

    expect(
      screen.getByText(
        'Asha wants to send you 2 files (2 MB): shared_asha_headshot.jpg, shared_asha_bio.txt.'
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save to folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onAccept.mock.calls).toEqual([[[a, b]]]);
    expect(onDecline.mock.calls).toEqual([[[a, b]]]);
    // The objects the list holds, not copies: the engine compares by identity.
    expect(onAccept.mock.calls[0]![0][0]).toBe(a);
    expect(onDecline.mock.calls[0]![0][1]).toBe(b);
  });

  it('names every sender when the files come from more than one person', () => {
    show({
      transfers: [file(), file({ id: 'file-2', from: 'Bo', name: 'shared_bo_bio.txt', size: 800_000 })],
    });
    expect(
      screen.getByText(
        'Asha, Bo want to send you 2 files (2 MB): shared_asha_headshot.jpg, shared_bo_bio.txt.'
      )
    ).toBeInTheDocument();
  });

  it('shows a picked file here and not among the backups, and a backup the other way round', () => {
    const { container, unmount } = show({ transfers: [backup] });
    expect(container.innerHTML).toBe('');
    unmount();

    const among = render(<BackupNotice role="host" transfers={[file()]} takeActive={false} />);
    expect(among.container.innerHTML).toBe('');
  });

  it('does not ask while a take records or saves', () => {
    show({ transfers: [file()], takeActive: true });
    expect(screen.queryByText(/wants to send you/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save to folder' })).toBeNull();
  });

  it('shows a file that is arriving with Stop, and one that stopped with a Dismiss that reaches the engine', () => {
    const onStop = vi.fn();
    const onDismiss = vi.fn();
    show({
      transfers: [
        file({ status: 'active', percent: 40 }),
        file({ id: 'file-2', status: 'stalled', percent: 10 }),
      ],
      onStop,
      onDismiss,
    });

    const [arriving, stopped] = screen.getAllByRole('status');
    expect(arriving!.textContent).toBe('Receiving a file from Asha — 40%. Keep this tab open.Stop');
    expect(stopped!.textContent).toBe(
      'Receiving a file from Asha stopped at 10%. It goes on if their connection comes back.Dismiss'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop.mock.calls).toEqual([['file-1']]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss.mock.calls).toEqual([['file-2']]);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('keeps the percent out of the screen reader, so a live region is not read for every point', () => {
    show({ transfers: [file({ status: 'active', percent: 40 })], onStop: vi.fn() });
    expect(screen.getByText('40%')).toHaveAttribute('aria-hidden', 'true');
  });

  it('names a saved file as it is in the folder, and says of one that was not saved that nothing was kept', () => {
    const onDismiss = vi.fn();
    show({
      transfers: [
        file({ status: 'saved', percent: 100, name: 'shared_asha_headshot_2.jpg' }),
        file({ id: 'file-2', status: 'failed' }),
      ],
      onDismiss,
    });

    expect(screen.getByRole('status').textContent).toBe(
      'Saved to your recording folder and verified: shared_asha_headshot_2.jpg.Dismiss'
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(
      'Not saved: a file from Asha. Nothing of it was kept, so ask them to send it again.Dismiss'
    );
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss.mock.calls).toEqual([['file-2']]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names a full disk as the reason', () => {
    show({ transfers: [file({ status: 'failed', diskFull: true })] });
    expect(screen.getByRole('alert').textContent).toBe(
      'Your disk is full: a file from Asha could not be saved. Free up space, then ask them to send it again.Dismiss'
    );
  });
});

describe('FileNotice, for the person who sent the file', () => {
  it('says the file waits for the host, during a take as well, and offers no answer', () => {
    const { rerender } = show({ role: 'guest', transfers: [mine()] });
    const waiting =
      'Waiting for the host to accept Headshot.JPG (1 MB). The host is asked between takes. Keep this tab open.';
    expect(screen.getByRole('status').textContent).toBe(waiting);
    expect(screen.queryByRole('button')).toBeNull();

    rerender(<FileNotice role="guest" transfers={[mine()]} takeActive />);
    expect(screen.getByRole('status').textContent).toBe(waiting);
  });

  it('shows the percent while it sends, and that it is paused while a take records here', () => {
    const sending = [mine({ status: 'active', percent: 40 })];
    const { rerender } = show({ role: 'guest', transfers: sending });
    expect(screen.getByRole('status').textContent).toBe(
      'Sending Headshot.JPG to the host — 40%. Keep this tab open.'
    );
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();

    rerender(<FileNotice role="guest" transfers={sending} takeActive />);
    expect(screen.getByRole('status').textContent).toBe(
      'Sending Headshot.JPG is paused while this take records.'
    );
  });

  it('says how each file ended, and tells the engine nothing when a row is sent away', () => {
    const onDismiss = vi.fn();
    show({
      role: 'guest',
      transfers: [
        mine({ status: 'saved', percent: 100 }),
        mine({ id: 'file-2', status: 'failed', name: 'bio.txt' }),
        mine({ id: 'file-3', status: 'stalled', percent: 30, name: 'slides.pdf' }),
      ],
      onDismiss,
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('The host didn’t save bio.txt. You can send it again.Dismiss');
    const [lost, done] = screen.getAllByRole('status');
    expect(lost!.textContent).toBe(
      'Sending slides.pdf stopped at 30%. It goes on when the connection to the host is back.Dismiss'
    );
    expect(done!.textContent).toBe('The host saved Headshot.JPG.Dismiss');
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(within(lost!).getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});

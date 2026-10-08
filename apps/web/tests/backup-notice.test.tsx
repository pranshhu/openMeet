import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BackupNotice } from '@/components/BackupNotice';
import { formatBytes } from '@/lib/sync-report';
import type { BackupTransfer } from '@/hooks/backup-return';

const BACKUP = 'backup_asha_camera_20231114T221320000Z.mp4';
const BACKUP_2 = 'backup_bo_camera_20231114T221421000Z.mp4';

const item = (over: Partial<BackupTransfer> = {}): BackupTransfer => ({
  id: BACKUP,
  kind: 'camera',
  size: 1_500_000_000,
  status: 'offered',
  percent: 0,
  from: 'Asha',
  ...over,
});

/** An item that arrived without a usable sender name. */
function nameless(over: Partial<BackupTransfer> = {}): BackupTransfer {
  const { from: _from, ...rest } = item(over);
  return rest;
}

function show(props: {
  role?: 'host' | 'guest' | null;
  transfers: BackupTransfer[];
  takeActive?: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onDismiss?: (id: string) => void;
  onStop?: (id: string) => void;
}) {
  return render(
    <BackupNotice
      role={props.role === undefined ? 'host' : props.role}
      transfers={props.transfers}
      takeActive={props.takeActive ?? false}
      onAccept={props.onAccept}
      onDecline={props.onDecline}
      onDismiss={props.onDismiss}
      onStop={props.onStop}
    />
  );
}

describe('BackupNotice', () => {
  it('renders nothing for an empty list', () => {
    const { container } = show({ transfers: [] });
    expect(container.innerHTML).toBe('');
  });

  it('offers two files from one guest with their summed size and answers both ways', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    show({
      transfers: [item({ id: 'a' }), item({ id: 'b', size: 500_000_000 })],
      onAccept,
      onDecline,
    });

    expect(
      screen.getByText(
        'Asha wants to send you 2 backup files (2.0 GB) from an earlier recording in this room.'
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save to folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('asks two named guests to send with "want"', () => {
    show({
      transfers: [
        item({ id: 'a', from: 'Asha' }),
        item({ id: 'b', from: 'Ben' }),
      ],
    });
    expect(
      screen.getByText(
        `Asha, Ben want to send you 2 backup files (${formatBytes(3_000_000_000)}) from an earlier recording in this room.`
      )
    ).toBeTruthy();
  });

  it('holds the offer back while a take is recording or saving', () => {
    show({ transfers: [item()], takeActive: true });
    expect(screen.queryByText(/wants to send you/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save to folder' })).toBeNull();
  });

  it('weights the percent of the active row by size', () => {
    show({
      transfers: [
        item({ id: 'a', status: 'active', percent: 40 }),
        item({ id: 'b', status: 'active', percent: 0 }),
      ],
    });
    expect(screen.getByRole('status').textContent).toBe(
      'Receiving 2 backup files — 20%. Keep this tab open.Stop'
    );
  });

  it('weighs a bigger active file more than a smaller one', () => {
    show({
      transfers: [
        item({ id: 'a', status: 'active', percent: 50, size: 3_000_000_000 }),
        item({ id: 'b', status: 'active', percent: 0, size: 1_000_000_000 }),
      ],
    });
    expect(screen.getByRole('status').textContent).toBe(
      'Receiving 2 backup files — 37%. Keep this tab open.Stop'
    );
  });

  it('counts only what is arriving, and tells a stalled transfer apart from it', () => {
    show({
      transfers: [
        item({ id: BACKUP, status: 'stalled', percent: 40, from: 'Asha' }),
        item({ id: BACKUP_2, status: 'active', percent: 50, from: 'Bo' }),
      ],
    });
    const rows = screen.getAllByRole('status').map((row) => row.textContent);
    expect(rows).toContain('Receiving 1 backup file — 50%. Keep this tab open.Stop');
    expect(rows).toContain('A backup stopped at 40%. It continues when Asha reconnects.Dismiss');
  });

  it('a stalled transfer keeps its line and its Dismiss while another transfer is moving', () => {
    const onDismiss = vi.fn();
    show({
      transfers: [
        item({ id: BACKUP, status: 'stalled', percent: 40, from: 'Asha' }),
        item({ id: BACKUP_2, status: 'active', from: 'Bo' }),
      ],
      onDismiss,
    });
    expect(screen.getByText(/It continues when Asha reconnects/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith(BACKUP);
  });

  it('lets the host stop every running transfer, and only tells the engine', () => {
    const onStop = vi.fn();
    show({
      transfers: [
        item({ id: BACKUP, status: 'active', percent: 40, from: 'Asha' }),
        item({ id: BACKUP_2, status: 'active', percent: 10, from: 'Bo' }),
      ],
      onStop,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(2);
    expect(onStop).toHaveBeenCalledWith(BACKUP);
    expect(onStop).toHaveBeenCalledWith(BACKUP_2);
    // The row waits for the engine's verdict: stopping here would take the
    // failed row and its own way out with it.
    expect(screen.getByRole('status').textContent).toBe(
      'Receiving 2 backup files — 25%. Keep this tab open.Stop'
    );
  });

  it('stops only what is arriving and leaves a stalled transfer to its own Dismiss', () => {
    const onStop = vi.fn();
    show({
      transfers: [
        item({ id: BACKUP, status: 'stalled', percent: 40, from: 'Asha' }),
        item({ id: BACKUP_2, status: 'active', percent: 50, from: 'Bo' }),
      ],
      onStop,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith(BACKUP_2);
  });

  it('keeps the Stop button safe to press with no handler', () => {
    // A throw out of a React event handler is reported on window, not out of
    // fireEvent, so the window listener is what catches it.
    const onError = vi.fn((e: ErrorEvent) => e.preventDefault());
    window.addEventListener('error', onError);
    try {
      show({ transfers: [item({ status: 'active', percent: 40 })] });
      const stopButton = screen.getByRole('button', { name: 'Stop' });
      expect(() => fireEvent.click(stopButton)).not.toThrow();
      expect(onError).not.toHaveBeenCalled();
      expect(screen.getByRole('status').textContent).toBe(
        'Receiving 1 backup file — 40%. Keep this tab open.Stop'
      );
    } finally {
      window.removeEventListener('error', onError);
    }
  });

  it('keeps the moving percent out of the spoken row', () => {
    const cases = [
      { role: 'host' as const, status: 'active' as const, percent: 40 },
      { role: 'host' as const, status: 'stalled' as const, percent: 30 },
      { role: 'guest' as const, status: 'active' as const, percent: 60 },
      { role: 'guest' as const, status: 'stalled' as const, percent: 15 },
    ];
    for (const c of cases) {
      const view = show({ role: c.role, transfers: [item({ status: c.status, percent: c.percent })] });
      const pct = view.container.querySelector('.tabular-nums');
      expect(pct?.textContent).toBe(`${c.percent}%`);
      expect(pct?.getAttribute('aria-hidden')).toBe('true');
      view.unmount();
    }
  });

  it('shows the saved row even while an offer waits', () => {
    show({
      transfers: [
        item({ id: 'offered' }),
        item({ id: 'saved', status: 'saved', percent: 100 }),
      ],
    });
    expect(screen.getByText(/1 backup file saved to your recording folder and verified\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save to folder' })).toBeTruthy();
  });

  it('names the sender of a stalled row and lets the host dismiss it', () => {
    const transfer = item({ status: 'stalled', percent: 30 });
    const { container } = show({ transfers: [transfer] });

    expect(screen.getByRole('status').textContent).toContain(
      'A backup stopped at 30%. It continues when Asha reconnects.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(container.innerHTML).toBe('');
  });

  it('hands a stalled host transfer to the engine when the host dismisses the row', () => {
    const onDismiss = vi.fn();
    const transfer = item({ status: 'stalled', percent: 30 });
    const { container } = show({ transfers: [transfer], onDismiss });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith(transfer.id);
    expect(container.innerHTML).toBe('');
  });

  it('hands a failed host transfer to the engine when the host dismisses the row', () => {
    const onDismiss = vi.fn();
    const transfer = item({ status: 'failed', percent: 10 });
    show({ transfers: [transfer], onDismiss });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith(transfer.id);
  });

  it('keeps a saved row’s dismissal on this screen', () => {
    const onDismiss = vi.fn();
    const transfer = item({ status: 'saved', percent: 100 });
    show({ transfers: [transfer], onDismiss });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('leaves a guest’s stalled transfer to this screen', () => {
    const onDismiss = vi.fn();
    show({ role: 'guest', transfers: [item({ status: 'stalled', percent: 30 })], onDismiss });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('leaves a guest’s failed transfer to this screen', () => {
    const onDismiss = vi.fn();
    show({ role: 'guest', transfers: [item({ status: 'failed', percent: 10 })], onDismiss });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives a receiving row no dismiss button', () => {
    show({ transfers: [item({ status: 'active', percent: 40 })] });
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('shows a saved line, dismisses it, and shows a re-sent backup again', () => {
    const saved = item({ status: 'saved', percent: 100 });
    const view = show({ transfers: [saved] });

    const line = '1 backup file saved to your recording folder and verified.';
    expect(screen.getByRole('status').textContent).toContain(line);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();

    view.rerender(
      <BackupNotice
        role="host"
        transfers={[item({ id: saved.id, status: 'saved', percent: 100 })]}
        takeActive={false}
      />
    );
    expect(screen.getByRole('status').textContent).toContain(line);
  });

  it('reports a failed arrival, and a full disk in its own words', () => {
    const view = show({ transfers: [item({ status: 'failed', percent: 10 })] });
    expect(screen.getByRole('alert').textContent).toContain(
      '1 backup file from Asha didn’t arrive intact. Ask them to send it again.'
    );

    view.rerender(
      <BackupNotice
        role="host"
        transfers={[item({ status: 'failed', percent: 10, diskFull: true })]}
        takeActive={false}
      />
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Your disk is full, so a backup wasn’t saved. Free up space, then ask Asha to send it again.'
    );
  });

  it('tells a guest what its own transfer is doing', () => {
    const view = show({
      role: 'guest',
      transfers: [nameless({ id: 'a' }), nameless({ id: 'b', size: 500_000_000 })],
    });
    expect(
      screen.getByText('Waiting for the host to accept your backup (2 files, 2.0 GB). Keep this tab open.')
    ).toBeTruthy();

    view.rerender(
      <BackupNotice
        role="guest"
        transfers={[item({ status: 'active', percent: 60 })]}
        takeActive={false}
      />
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Sending your backup to the host — 60%. Keep this tab open.'
    );

    view.rerender(
      <BackupNotice role="guest" transfers={[item({ status: 'active', percent: 60 })]} takeActive />
    );
    expect(screen.getByText('Sending your backup is paused while this take records.')).toBeTruthy();

    view.rerender(
      <BackupNotice role="guest" transfers={[item({ status: 'stalled', percent: 15 })]} takeActive={false} />
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Lost the connection to the host at 15%. Sending continues when it’s back.'
    );

    view.rerender(
      <BackupNotice role="guest" transfers={[item({ status: 'saved', percent: 100 })]} takeActive={false} />
    );
    expect(
      screen.getByText(
        'The host saved your backup and verified it. You can delete it from this device in the lobby.'
      )
    ).toBeTruthy();

    view.rerender(
      <BackupNotice role="guest" transfers={[item({ status: 'failed', percent: 15 })]} takeActive={false} />
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Your backup wasn’t saved on the host’s computer. It’s still on this device — rejoin to send it again.'
    );
  });

  it('treats a missing role as a guest, not a host', () => {
    show({ role: null, transfers: [item({ status: 'offered' })] });
    expect(
      screen.getByText(
        'Waiting for the host to accept your backup (1 file, 1.5 GB). Keep this tab open.'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save to folder' })).toBeNull();
  });

  it('keeps the waiting and saved lines off a guest’s screen while bytes move', () => {
    const view = show({
      role: 'guest',
      transfers: [
        item({ id: 'a', status: 'offered' }),
        item({ id: 'b', status: 'active', percent: 60 }),
      ],
    });
    expect(screen.getByRole('status').textContent).toBe(
      'Sending your backup to the host — 60%. Keep this tab open.'
    );

    view.rerender(
      <BackupNotice
        role="guest"
        transfers={[
          item({ id: 'c', status: 'offered' }),
          item({ id: 'd', status: 'saved', percent: 100 }),
        ]}
        takeActive={false}
      />
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Waiting for the host to accept your backup (1 file, 1.5 GB). Keep this tab open.'
    );
  });

  it('calls the disk full when any failed file ran out of space', () => {
    show({
      transfers: [
        item({ id: 'a', status: 'failed', percent: 10 }),
        item({ id: 'b', status: 'failed', percent: 10, diskFull: true }),
      ],
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'Your disk is full, so a backup wasn’t saved. Free up space, then ask Asha to send it again.'
    );
  });

  it('makes every button a plain button', () => {
    const { container } = show({
      transfers: [item({ id: 'failed', status: 'failed' }), item({ id: 'offered' })],
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBe(3);
    for (const button of buttons) expect(button.getAttribute('type')).toBe('button');
  });

  it('keeps a failure alert up while a take records', () => {
    show({ transfers: [item({ status: 'failed', percent: 10 })], takeActive: true });
    expect(screen.getByRole('alert').textContent).toContain(
      '1 backup file from Asha didn’t arrive intact. Ask them to send it again.'
    );
  });

  it('calls a row without a sender name "A guest"', () => {
    const view = show({ transfers: [nameless()] });
    expect(
      screen.getByText('A guest wants to send you 1 backup file (1.5 GB) from an earlier recording in this room.')
    ).toBeTruthy();

    view.rerender(
      <BackupNotice
        role="host"
        transfers={[nameless({ status: 'stalled', percent: 30 })]}
        takeActive={false}
      />
    );
    expect(screen.getByRole('status').textContent).toContain(
      'A backup stopped at 30%. It continues when A guest reconnects.'
    );
  });

  it('tells a guest the host said no, in words that stay true', () => {
    show({ role: 'guest', transfers: [item({ status: 'failed', percent: 10 })] });
    expect(screen.getByRole('alert').textContent).toContain(
      'Your backup wasn’t saved on the host’s computer. It’s still on this device — rejoin to send it again.'
    );
    expect(screen.queryByText(/The host didn’t get your backup/)).toBeNull();
  });

  it('tells a tab with no role yet that the backup was not saved', () => {
    show({ role: null, transfers: [item({ status: 'failed', percent: 10 })] });
    expect(screen.getByRole('alert').textContent).toContain(
      'Your backup wasn’t saved on the host’s computer. It’s still on this device — rejoin to send it again.'
    );
  });

  it('announces a saved backup while another is still arriving', () => {
    show({
      transfers: [
        item({ id: 'a', status: 'active', percent: 40 }),
        item({ id: 'b', status: 'saved', percent: 100 }),
      ],
    });
    expect(screen.getAllByRole('status').map((row) => row.textContent)).toEqual([
      'Receiving 1 backup file — 40%. Keep this tab open.Stop',
      '1 backup file saved to your recording folder and verified.Dismiss',
    ]);
  });

  it('announces a saved backup while another transfer is stalled', () => {
    show({
      transfers: [
        item({ id: BACKUP, status: 'stalled', percent: 40, from: 'Asha' }),
        item({ id: BACKUP_2, status: 'saved', percent: 100, from: 'Bo' }),
      ],
    });
    expect(screen.getAllByRole('status').map((row) => row.textContent)).toEqual([
      'A backup stopped at 40%. It continues when Asha reconnects.Dismiss',
      '1 backup file saved to your recording folder and verified.Dismiss',
    ]);
  });

  it('holds the guest’s saved line back while bytes are moving', () => {
    show({
      role: 'guest',
      transfers: [
        item({ id: 'a', status: 'active', percent: 60 }),
        item({ id: 'b', status: 'saved', percent: 100 }),
      ],
    });
    expect(screen.getAllByRole('status').map((row) => row.textContent)).toEqual([
      'Sending your backup to the host — 60%. Keep this tab open.',
    ]);
  });
});

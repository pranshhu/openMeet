'use client';

import { useState, type ReactNode } from 'react';
import type { Role } from '@openmeet/protocol';
import type { BackupTransfer } from '@/hooks/backup-return';
import { formatBytes } from '@/lib/sync-report';

const quietBtn =
  'inline-flex min-h-11 items-center rounded-full px-2 py-0.5 text-xs text-white/80 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:min-h-8';
const filledBtn =
  'inline-flex min-h-11 items-center rounded-full bg-[#8ab4f8] px-4 font-medium text-[#202124] transition-colors hover:bg-[#aecbfa] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:min-h-8';

/** The names of a row's senders, or a stand-in when the offer carried none. */
function whoOf(row: BackupTransfer[]): string {
  const names = [...new Set(row.map((t) => t.from).filter((n): n is string => Boolean(n)))];
  return names.length > 0 ? names.join(', ') : 'A guest';
}

/** The size-weighted whole percent of the bytes in a row that are moving. */
function pctOf(row: BackupTransfer[]): number {
  const total = row.reduce((sum, t) => sum + t.size, 0);
  if (total <= 0) return 0;
  return Math.floor(row.reduce((sum, t) => sum + t.size * t.percent, 0) / total);
}

function files(n: number): string {
  return `${n} backup file${n === 1 ? '' : 's'}`;
}

function Row({ tone, children }: { tone: 'status' | 'saved' | 'alert'; children: ReactNode }) {
  const colour =
    tone === 'alert' ? 'text-[#f6aea9]' : tone === 'saved' ? 'text-[#81c995]' : 'text-white/90';
  return (
    <div
      role={tone === 'alert' ? 'alert' : 'status'}
      className={`mb-1 flex max-w-[92vw] flex-wrap items-center justify-center gap-2 self-center rounded-2xl bg-black/40 px-3 py-1 text-center text-xs ${colour}`}
    >
      {children}
    </div>
  );
}

/**
 * What a returned backup is doing, inside the call. Its own component so the
 * rows stay out of the stage's body.
 */
export function BackupNotice(props: {
  role: Role | null;
  transfers: BackupTransfer[];
  /** A take is recording or saving. */
  takeActive: boolean;
  onAccept?: (() => void) | undefined;
  onDecline?: (() => void) | undefined;
  /** The host gave up on a dead transfer: drop it so its name can come back. */
  onDismiss?: ((id: string) => void) | undefined;
  /** The host ends a running transfer, keeping the part that arrived. */
  onStop?: ((id: string) => void) | undefined;
}): ReactNode {
  // The settled items the user sent away, kept as the objects themselves: a
  // backup that is sent again is a new object and shows again.
  const [dismissed, setDismissed] = useState<BackupTransfer[]>([]);
  const items = props.transfers.filter((t) => !dismissed.includes(t));
  const byStatus = (...statuses: BackupTransfer['status'][]) =>
    items.filter((t) => statuses.includes(t.status));
  const failed = byStatus('failed');
  const offered = byStatus('offered');
  const moving = byStatus('active', 'stalled');
  const active = moving.filter((t) => t.status === 'active');
  const stalled = moving.filter((t) => t.status === 'stalled');
  const saved = byStatus('saved');

  // A row of dead transfers is the host giving up on them: the engine has to
  // hear it, so the sender's name is free again. Everything else is this screen.
  const dismiss = (row: BackupTransfer[], tellEngine: boolean) => {
    if (tellEngine) for (const t of row) props.onDismiss?.(t.id);
    setDismissed((d) => [...d, ...row]);
  };
  const dismissBtn = (row: BackupTransfer[], tellEngine = false) => (
    <button type="button" onClick={() => dismiss(row, tellEngine)} className={quietBtn}>
      Dismiss
    </button>
  );

  const rows: ReactNode[] = [];

  if (failed.length > 0) {
    const who = whoOf(failed);
    rows.push(
      <Row key="failed" tone="alert">
        <span>
          {props.role !== 'host'
            ? 'Your backup wasn’t saved on the host’s computer. It’s still on this device — rejoin to send it again.'
            : failed.some((t) => t.diskFull)
              ? `Your disk is full, so a backup wasn’t saved. Free up space, then ask ${who} to send it again.`
              : `${files(failed.length)} from ${who} didn’t arrive intact. Ask them to send it again.`}
        </span>
        {dismissBtn(failed, props.role === 'host')}
      </Row>
    );
  }

  if (props.role === 'host') {
    if (offered.length > 0 && !props.takeActive) {
      rows.push(
        <Row key="offered" tone="status">
          <span>
            {`${whoOf(offered)} ${new Set(offered.map((t) => t.from)).size > 1 ? 'want' : 'wants'} to send you ${files(offered.length)} (${formatBytes(offered.reduce((sum, t) => sum + t.size, 0))}) from an earlier recording in this room.`}
          </span>
          <button type="button" onClick={props.onAccept} className={filledBtn}>
            Save to folder
          </button>
          <button type="button" onClick={props.onDecline} className={quietBtn}>
            Not now
          </button>
        </Row>
      );
    }

    if (active.length > 0) {
      rows.push(
        <Row key="moving" tone="status">
          <span>
            Receiving {files(active.length)} —{' '}
            <span className="tabular-nums" aria-hidden="true">
              {pctOf(active)}%
            </span>
            . Keep this tab open.
          </span>
          <button
            type="button"
            onClick={() => active.forEach((t) => props.onStop?.(t.id))}
            className={quietBtn}
          >
            Stop
          </button>
        </Row>
      );
    }

    if (stalled.length > 0) {
      rows.push(
        <Row key="stalled" tone="status">
          <span>
            A backup stopped at{' '}
            <span className="tabular-nums" aria-hidden="true">
              {pctOf(stalled)}%
            </span>
            . It continues when {whoOf(stalled)} reconnects.
          </span>
          {dismissBtn(stalled, true)}
        </Row>
      );
    }

    if (saved.length > 0) {
      rows.push(
        <Row key="saved" tone="saved">
          <span>{files(saved.length)} saved to your recording folder and verified.</span>
          {dismissBtn(saved)}
        </Row>
      );
    }
  } else {
    if (active.length > 0 && props.takeActive) {
      rows.push(
        <Row key="paused" tone="status">
          <span>Sending your backup is paused while this take records.</span>
        </Row>
      );
    } else if (active.length > 0) {
      rows.push(
        <Row key="sending" tone="status">
          <span>
            Sending your backup to the host —{' '}
            <span className="tabular-nums" aria-hidden="true">
              {pctOf(active)}%
            </span>
            . Keep this tab open.
          </span>
        </Row>
      );
    } else if (stalled.length > 0) {
      rows.push(
        <Row key="lost" tone="status">
          <span>
            Lost the connection to the host at{' '}
            <span className="tabular-nums" aria-hidden="true">
              {pctOf(stalled)}%
            </span>
            . Sending continues when it’s back.
          </span>
          {dismissBtn(stalled)}
        </Row>
      );
    }

    if (offered.length > 0 && moving.length === 0) {
      rows.push(
        <Row key="waiting" tone="status">
          <span>
            Waiting for the host to accept your backup ({offered.length} file
            {offered.length === 1 ? '' : 's'},{' '}
            {formatBytes(offered.reduce((sum, t) => sum + t.size, 0))}). Keep this tab open.
          </span>
        </Row>
      );
    }

    if (saved.length > 0 && offered.length === 0 && moving.length === 0) {
      rows.push(
        <Row key="saved" tone="saved">
          <span>
            The host saved your backup and verified it. You can delete it from this device in the lobby.
          </span>
          {dismissBtn(saved)}
        </Row>
      );
    }
  }

  return rows.length > 0 ? <>{rows}</> : null;
}

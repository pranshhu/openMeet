'use client';

import { useState, type ReactNode } from 'react';
import type { Role } from '@openmeet/protocol';
import type { BackupTransfer } from '@/hooks/backup-return';
import { formatBytes } from '@/lib/sync-report';
import { Row, filledBtn, pctOf, quietBtn, whoOf } from './BackupNotice';

const count = (row: BackupTransfer[]) => (row.length === 1 ? 'a file' : `${row.length} files`);
const namesOf = (row: BackupTransfer[]) => row.map((t) => t.name ?? 'a file').join(', ');
const bytesOf = (row: BackupTransfer[]) => formatBytes(row.reduce((sum, t) => sum + t.size, 0));

/**
 * What a file a participant picked to send the host is doing, inside the
 * call: the host's question, and how it ended on both sides. Beside
 * BackupNotice, whose rows are worded for backups; of the list both are
 * given, this one shows the picked files only.
 */
export function FileNotice(props: {
  role: Role | null;
  transfers: BackupTransfer[];
  /** A take is recording or saving in this tab. */
  takeActive: boolean;
  /** The host saves the offered files this row shows. */
  onAccept?: ((shown: BackupTransfer[]) => void) | undefined;
  /** The host turns the offered files this row shows down. */
  onDecline?: ((shown: BackupTransfer[]) => void) | undefined;
  /** The host gave up on a transfer that stopped or failed, so its record is dropped. */
  onDismiss?: ((id: string) => void) | undefined;
  /** The host ends a running transfer; nothing of the file is kept. */
  onStop?: ((id: string) => void) | undefined;
}): ReactNode {
  // The rows the user sent away, kept as the objects themselves: a file that
  // is sent again is a new object and shows again.
  const [dismissed, setDismissed] = useState<BackupTransfer[]>([]);
  const items = props.transfers.filter((t) => t.kind === 'file' && !dismissed.includes(t));
  const by = (status: BackupTransfer['status']) => items.filter((t) => t.status === status);
  const host = props.role === 'host';
  const failed = by('failed');
  const offered = by('offered');
  const active = by('active');
  const stalled = by('stalled');
  const saved = by('saved');

  // The host giving up on a transfer has to reach the engine, which holds its
  // record and its file. Everything else is this screen's own.
  const dismissBtn = (row: BackupTransfer[], tellEngine = false) => (
    <button
      type="button"
      onClick={() => {
        if (tellEngine) for (const t of row) props.onDismiss?.(t.id);
        setDismissed((d) => [...d, ...row]);
      }}
      className={quietBtn}
    >
      Dismiss
    </button>
  );
  const pct = (row: BackupTransfer[]) => (
    <span className="tabular-nums" aria-hidden="true">
      {pctOf(row)}%
    </span>
  );

  const rows: ReactNode[] = [];

  if (failed.length > 0) {
    rows.push(
      <Row key="failed" tone="alert">
        <span className="wrap-anywhere">
          {!host
            ? `The host didn’t save ${namesOf(failed)}. You can send it again.`
            : failed.some((t) => t.diskFull)
              ? `Your disk is full: ${count(failed)} from ${whoOf(failed)} could not be saved. Free up space, then ask them to send it again.`
              : `Not saved: ${count(failed)} from ${whoOf(failed)}. Nothing of it was kept, so ask them to send it again.`}
        </span>
        {dismissBtn(failed, host)}
      </Row>
    );
  }

  // The host is not asked while its take records or saves: the offers wait.
  if (offered.length > 0 && !(host && props.takeActive)) {
    rows.push(
      host ? (
        <Row key="offered" tone="status">
          <span className="wrap-anywhere">
            {`${whoOf(offered)} ${new Set(offered.map((t) => t.from)).size > 1 ? 'want' : 'wants'} to send you ${count(offered)} (${bytesOf(offered)}): ${namesOf(offered)}.`}
          </span>
          <button type="button" onClick={() => props.onAccept?.(offered)} className={filledBtn}>
            Save to folder
          </button>
          <button type="button" onClick={() => props.onDecline?.(offered)} className={quietBtn}>
            Not now
          </button>
        </Row>
      ) : (
        <Row key="offered" tone="status">
          <span className="wrap-anywhere">
            {`Waiting for the host to accept ${namesOf(offered)} (${bytesOf(offered)}). The host is asked between takes. Keep this tab open.`}
          </span>
        </Row>
      )
    );
  }

  if (active.length > 0) {
    rows.push(
      <Row key="active" tone="status">
        {!host && props.takeActive ? (
          <span className="wrap-anywhere">
            {`Sending ${namesOf(active)} is paused while this take records.`}
          </span>
        ) : (
          <span className="wrap-anywhere">
            {host
              ? `Receiving ${count(active)} from ${whoOf(active)} — `
              : `Sending ${namesOf(active)} to the host — `}
            {pct(active)}. Keep this tab open.
          </span>
        )}
        {host && (
          <button
            type="button"
            onClick={() => active.forEach((t) => props.onStop?.(t.id))}
            className={quietBtn}
          >
            Stop
          </button>
        )}
      </Row>
    );
  }

  if (stalled.length > 0) {
    rows.push(
      <Row key="stalled" tone="status">
        <span className="wrap-anywhere">
          {host
            ? `Receiving ${count(stalled)} from ${whoOf(stalled)} stopped at `
            : `Sending ${namesOf(stalled)} stopped at `}
          {pct(stalled)}
          {host
            ? '. It goes on if their connection comes back.'
            : '. It goes on when the connection to the host is back.'}
        </span>
        {dismissBtn(stalled, host)}
      </Row>
    );
  }

  if (saved.length > 0) {
    rows.push(
      <Row key="saved" tone="saved">
        <span className="wrap-anywhere">
          {host
            ? `Saved to your recording folder and verified: ${namesOf(saved)}.`
            : `The host saved ${namesOf(saved)}.`}
        </span>
        {dismissBtn(saved)}
      </Row>
    );
  }

  return rows.length > 0 ? <>{rows}</> : null;
}

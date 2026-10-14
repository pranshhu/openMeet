'use client';

import type { ReactNode } from 'react';
import type { Role, WaitingPerson } from '@openmeet/protocol';
import { Row, filledBtn, quietBtn } from './BackupNotice';

// A longer list is the host's to work through one at a time; the rest is a count.
const MAX_ROWS = 3;

/** A waiting person as the People panel writes them. */
function labelOf(p: WaitingPerson): string {
  const name = p.displayName || 'Guest';
  return p.role === 'producer' ? `${name} (Producer)` : p.companion ? `${name} (Presenting)` : name;
}

/**
 * The people at the door of a room with a waiting room, for its host: one row
 * each, with Let in and Refuse. Its own component so the rows stay out of the
 * stage's body.
 */
export function KnockNotice({
  role,
  waiting,
  onAdmit,
}: {
  role: Role | null;
  waiting: WaitingPerson[];
  onAdmit?: ((peerId: string, admit: boolean) => void) | undefined;
}): ReactNode {
  if (role !== 'host') return null;
  const more = waiting.length - MAX_ROWS;
  return (
    <>
      {waiting.slice(0, MAX_ROWS).map((p) => {
        const label = labelOf(p);
        return (
          <Row key={p.peerId} tone="status">
            <span className="flex min-w-0 max-w-full items-baseline gap-1">
              <bdi className="inline-block max-w-[14rem] truncate font-medium">{label}</bdi>{' '}
              <span>wants to join</span>
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                aria-label={`Let ${label} in`}
                onClick={() => onAdmit?.(p.peerId, true)}
                className={filledBtn}
              >
                Let in
              </button>
              <button
                type="button"
                aria-label={`Refuse ${label}`}
                onClick={() => onAdmit?.(p.peerId, false)}
                className={quietBtn}
              >
                Refuse
              </button>
            </span>
          </Row>
        );
      })}
      {more > 0 && <Row tone="status">and {more} more waiting</Row>}
    </>
  );
}

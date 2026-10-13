import type { WaitingPerson } from '@openmeet/protocol';

const MAX_WAITING = 8;
const MAX_PEER_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 64;

/** What the Room last said about who may join: the lock, the waiting room and the people at its door. */
export interface RoomAccess {
  locked: boolean;
  waitingRoom: boolean;
  waiting: WaitingPerson[];
}

/** The people at the door, read where they arrive: the first eight whose id is usable, with a name that fits. */
function readWaiting(v: unknown): WaitingPerson[] {
  const people: WaitingPerson[] = [];
  if (!Array.isArray(v)) return people;
  for (const e of v) {
    if (people.length >= MAX_WAITING) break;
    const { peerId, displayName, role, companion } = (e ?? {}) as Record<string, unknown>;
    if (typeof peerId !== 'string' || peerId === '' || peerId.length > MAX_PEER_ID_LENGTH) continue;
    people.push({
      peerId,
      displayName: typeof displayName === 'string' ? displayName.slice(0, MAX_NAME_LENGTH) : '',
      role: role === 'producer' ? 'producer' : 'guest',
      ...(companion === true ? { companion: true } : {}),
    });
  }
  return people;
}

/** The Room's `room-access`, read where it arrives: only a real `true` is a lock or a waiting room. */
export function readRoomAccess(m: unknown): RoomAccess {
  const o = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {};
  return { locked: o.locked === true, waitingRoom: o.waitingRoom === true, waiting: readWaiting(o.waiting) };
}

/** Whether the host has locked the room, as the Room last said. */
export interface RoomAccess {
  locked: boolean;
}

/** The Room's `room-access`, read where it arrives: only a real `true` is a lock. */
export function readRoomAccess(m: unknown): RoomAccess {
  return { locked: typeof m === 'object' && m !== null && (m as { locked?: unknown }).locked === true };
}

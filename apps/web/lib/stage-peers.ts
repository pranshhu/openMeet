import type { Role } from '@openmeet/protocol';

/**
 * Whether one of the other people in the room has a camera tile of their own.
 * A producer and a Present-only device send no camera, so they have none.
 */
export function isStagePeer(p: { role?: Role | undefined; companion?: boolean | undefined }): boolean {
  return p.role !== 'producer' && !p.companion;
}

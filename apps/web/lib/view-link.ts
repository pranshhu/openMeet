import type { Role } from '@openmeet/protocol';
import { isStagePeer } from '@/lib/stage-peers';

/**
 * A room link with a `view` parameter is a page that shows one person's camera
 * and sound, for a browser source in streaming software or a second screen.
 * A peer id changes on every socket and a client id is never shared, so the
 * person is named by their role (the host) or by their display name (a guest).
 */
export type ViewLink = { kind: 'host' } | { kind: 'guest'; name: string } | { kind: 'incomplete' };

// The length the Room keeps of a display name.
const MAX_NAME_LENGTH = 64;

/** The link in an address's query string, or null when it has no `view` parameter. */
export function parseViewLink(search: string): ViewLink | null {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  if (view === null) return null;
  if (view === 'host') return { kind: 'host' };
  const name = (params.get('name') ?? '').trim();
  if (view !== 'guest' || name === '') return { kind: 'incomplete' };
  // Cut as the Room cuts a name, so a long one still matches the person it names.
  return { kind: 'guest', name: name.slice(0, MAX_NAME_LENGTH).replace(/[\uD800-\uDBFF]$/, '') };
}

/** The name this page joins the room under, as the host's People panel lists it. */
export function viewName(link: ViewLink): string {
  return link.kind === 'guest' ? `View of ${link.name}` : 'View of the host';
}

const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** The first of the other people who is the one the link names; a producer and a Present-only device never are. */
export function findViewed<P extends { name: string | null; role?: Role | undefined; companion?: boolean | undefined }>(
  peers: readonly P[],
  link: ViewLink
): P | null {
  if (link.kind === 'host') return peers.find((p) => p.role === 'host') ?? null;
  if (link.kind === 'incomplete') return null;
  return peers.find((p) => isStagePeer(p) && p.role === 'guest' && p.name !== null && same(p.name, link.name)) ?? null;
}

/** Whether the person's camera is off, as the call's tile decides it. */
export function viewCamOff(peer: {
  audioOnly?: boolean | undefined;
  presence?: { camOn: boolean } | undefined;
  stream: MediaStream | null;
}): boolean {
  return peer.audioOnly === true || (peer.presence ? !peer.presence.camOn : !peer.stream);
}

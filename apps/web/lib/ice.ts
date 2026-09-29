import type { TurnCred } from './api';

/**
 * Turn a minted credential into RTCIceServer entries.
 *
 * Two cases need a BARE entry (no username/credential):
 *  - the stub the Worker returns when no TURN is configured at all
 *  - a self-hosted/static config that supplies only STUN URLs, or a coturn with
 *    no long-term credentials
 *
 * Passing empty-string credentials alongside a turn: URL is not the same as
 * omitting them — Chrome rejects the entry, which would silently remove the
 * relay path rather than fall back to STUN.
 */
export function buildIceServers(cred: TurnCred): RTCIceServer[] {
  const isStub = cred.username === 'stub' && cred.credential === 'stub';
  if (isStub || !cred.username || !cred.credential) {
    return [{ urls: cred.urls }];
  }
  return [{ urls: cred.urls, username: cred.username, credential: cred.credential }];
}

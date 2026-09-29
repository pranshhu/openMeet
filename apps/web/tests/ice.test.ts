import { describe, it, expect } from 'vitest';
import { buildIceServers } from '@/lib/ice';

describe('buildIceServers', () => {
  it('maps a TURN cred into a single RTCIceServer entry', () => {
    const servers = buildIceServers({
      urls: ['turn:turn.cloudflare.com:3478', 'stun:stun.cloudflare.com:3478'],
      username: 'u',
      credential: 'c',
      ttl: 600,
    });
    expect(servers).toEqual([
      {
        urls: ['turn:turn.cloudflare.com:3478', 'stun:stun.cloudflare.com:3478'],
        username: 'u',
        credential: 'c',
      },
    ]);
  });

  it('omits username/credential for a stun-only stub cred', () => {
    const servers = buildIceServers({
      urls: ['stun:stun.cloudflare.com:3478'],
      username: 'stub',
      credential: 'stub',
      ttl: 600,
    });
    expect(servers).toEqual([{ urls: ['stun:stun.cloudflare.com:3478'] }]);
  });
});

describe('buildIceServers with self-hosted TURN', () => {
  // A static/self-hosted config may supply STUN-only URLs, or a coturn with no
  // long-term credentials. Passing empty-string credentials alongside a turn:
  // URL is NOT the same as omitting them — Chrome rejects the entry outright,
  // which silently removes the relay path instead of falling back to STUN.
  it('emits a bare entry when credentials are empty', () => {
    const servers = buildIceServers({
      urls: ['stun:stun.example.org:3478'],
      username: '',
      credential: '',
      ttl: 600,
    });
    expect(servers).toEqual([{ urls: ['stun:stun.example.org:3478'] }]);
  });

  it('keeps credentials for a real self-hosted coturn', () => {
    const servers = buildIceServers({
      urls: ['turn:turn.example.org:3478', 'turns:turn.example.org:5349'],
      username: 'openmeet',
      credential: 's3cret',
      ttl: 600,
    });
    expect(servers[0]).toMatchObject({ username: 'openmeet', credential: 's3cret' });
    expect(servers[0]!.urls).toHaveLength(2);
  });
});

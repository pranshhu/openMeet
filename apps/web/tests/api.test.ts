import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoom, getRoom, getTurnCred, patchRecording, getSponsors } from '@/lib/api';

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createRoom POSTs with credentials and returns slug + host_token', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({ slug: 'xyz-abcd-pqr', host_token: 'abc', expires_at: 123 }),
        { status: 201 }
      )
    );
    const out = await createRoom();
    expect(out).toEqual({ slug: 'xyz-abcd-pqr', host_token: 'abc', expires_at: 123 });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/rooms');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('createRoom throws on non-201', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(createRoom()).rejects.toThrow();
  });

  it('getRoom returns null on 404', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('{}', { status: 404 }));
    expect(await getRoom('xyz-abcd-pqr')).toBeNull();
  });

  it('getRoom returns metadata on 200', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ slug: 'xyz-abcd-pqr', expires_at: 9, consumed: 0 }), {
        status: 200,
      })
    );
    expect(await getRoom('xyz-abcd-pqr')).toEqual({
      slug: 'xyz-abcd-pqr',
      expires_at: 9,
      consumed: 0,
    });
  });

  it('getTurnCred POSTs slug and returns ice config', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({ urls: ['stun:stun.cloudflare.com:3478'], username: 'u', credential: 'c', ttl: 600 }),
        { status: 200 }
      )
    );
    const cred = await getTurnCred('xyz-abcd-pqr');
    expect(cred.urls).toContain('stun:stun.cloudflare.com:3478');
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ slug: 'xyz-abcd-pqr' });
  });

  it('patchRecording sends Authorization: Bearer when a host token is given', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    await patchRecording('rec1', { status: 'finalized' }, 'tok-99');
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/recordings/rec1');
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-99');
  });

  it('patchRecording omits Authorization when no host token', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    await patchRecording('rec1', { status: 'finalized' });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('getSponsors fetches /api/sponsors and returns sponsors data', async () => {
    const mockData = {
      checkoutUrl: 'https://buy.polar.sh/sample',
      sponsors: [{ name: 'Acme', url: 'https://acme.com', logo: null, weight: 0.5 }],
      available: 0.5,
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(mockData), { status: 200 })
    );
    const data = await getSponsors();
    expect(data).toEqual(mockData);
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/sponsors');
  });

  it('getSponsors throws on non-200', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(getSponsors()).rejects.toThrow();
  });
});

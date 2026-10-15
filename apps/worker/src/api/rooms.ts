import type { Context } from 'hono';
import { ROOM_TTL_MS, isRoomName } from '@openmeet/protocol';
import type { Env } from '../env.js';
import { generateSlug, isValidSlugFormat } from '../lib/slug.js';
import { generateHostToken } from '../lib/token.js';
import { serializeHostTokenCookie } from '../lib/cookie.js';
import { corsHeaders } from '../lib/cors.js';
import { getRoomBySlug, insertRoom } from '../db/queries.js';

let warnedMissingRateLimiter = false;

const MAX_COLLISION_RETRIES = 5;

export async function postRooms(c: Context<{ Bindings: Env }>): Promise<Response> {
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
  if (c.env.ROOM_CREATE_LIMITER) {
    // Known limit: counters are per Cloudflare location, not global; a Durable Object limiter is the upgrade if abuse turns out to be cross-location.
    const { success } = await c.env.ROOM_CREATE_LIMITER.limit({ key: ip });
    if (!success) {
      return c.json({ error: 'rate_limited' }, 429);
    }
  } else {
    // Known limit: fail-open because a rate limiter is abuse mitigation, and a missing binding must not take room creation down.
    if (!warnedMissingRateLimiter) {
      warnedMissingRateLimiter = true;
      console.error('rooms:no_rate_limiter');
    }
  }
  // A missing or unreadable body is a request with no name.
  const body: unknown = await c.req.json().catch(() => null);
  const named = typeof body === 'object' && body !== null && 'name' in body;
  const name = named ? (body as { name: unknown }).name : undefined;
  if (named && !isRoomName(name)) {
    return c.json({ error: 'invalid_name' }, 400);
  }

  const now = Date.now();
  const expiresAt = now + ROOM_TTL_MS;
  const hostToken = generateHostToken();
  const row = (slug: string) => ({ slug, host_token: hostToken, created_at: now, expires_at: expiresAt });

  let slug = '';
  if (isRoomName(name)) {
    // Whether the name is free is decided by the insert itself, so two requests
    // for one name cannot both win. An expired row keeps its name.
    if (!(await insertRoom(c.env.DB, row(name)))) {
      return c.json({ error: 'name_taken' }, 409);
    }
    slug = name;
  } else {
    for (let i = 0; i < MAX_COLLISION_RETRIES && !slug; i++) {
      const candidate = generateSlug();
      if (await insertRoom(c.env.DB, row(candidate))) slug = candidate;
    }
    if (!slug) {
      return c.json({ error: 'slug_exhausted' }, 503);
    }
  }

  const requestOrigin = c.req.header('Origin') ?? null;
  const headers: HeadersInit = {
    'Set-Cookie': serializeHostTokenCookie(slug, hostToken, {
      secure: new URL(c.req.url).protocol === 'https:',
    }),
    'Content-Type': 'application/json',
    ...corsHeaders(c.env.PAGES_ORIGIN, requestOrigin),
  };

  // host_token is returned in the body so the client can present it in the WS
  // join message and in Authorization headers when cookies can't cross origins.
  return new Response(JSON.stringify({ slug, host_token: hostToken, expires_at: expiresAt }), {
    status: 201,
    headers,
  });
}

export async function getRoomsSlug(c: Context<{ Bindings: Env }>): Promise<Response> {
  const slug = c.req.param('slug');
  if (!slug || !isValidSlugFormat(slug)) {
    return c.json({ error: 'invalid_slug' }, 404);
  }
  const row = await getRoomBySlug(c.env.DB, slug);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.expires_at < Date.now()) return c.json({ error: 'expired' }, 404);
  const requestOrigin = c.req.header('Origin') ?? null;
  return new Response(
    JSON.stringify({ slug: row.slug, expires_at: row.expires_at, consumed: row.consumed }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(c.env.PAGES_ORIGIN, requestOrigin),
      },
    }
  );
}

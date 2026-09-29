import type { Context } from 'hono';
import { ROOM_TTL_MS } from '@openmeet/protocol';
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
  const now = Date.now();
  const expiresAt = now + ROOM_TTL_MS;
  const hostToken = generateHostToken();

  let slug = '';
  for (let i = 0; i < MAX_COLLISION_RETRIES; i++) {
    const candidate = generateSlug();
    const existing = await getRoomBySlug(c.env.DB, candidate);
    if (!existing) {
      slug = candidate;
      break;
    }
  }
  if (!slug) {
    return c.json({ error: 'slug_exhausted' }, 503);
  }

  await insertRoom(c.env.DB, {
    slug,
    host_token: hostToken,
    created_at: now,
    expires_at: expiresAt,
  });

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

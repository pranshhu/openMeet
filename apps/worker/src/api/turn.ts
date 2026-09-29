import type { Context } from 'hono';
import { TURN_CRED_TTL_S } from '@openmeet/protocol';
import type { Env } from '../env.js';
import { isValidSlugFormat } from '../lib/slug.js';
import { getRoomBySlug } from '../db/queries.js';
import { corsHeaders } from '../lib/cors.js';

interface TurnCredResponse {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
}

let warnedMissingRateLimiter = false;

export async function postTurnCred(c: Context<{ Bindings: Env }>): Promise<Response> {
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
  if (c.env.TURN_CRED_LIMITER) {
    // Known limit: counters are per Cloudflare location, not global; a Durable Object limiter is the upgrade if abuse turns out to be cross-location.
    const { success } = await c.env.TURN_CRED_LIMITER.limit({ key: ip });
    if (!success) {
      return c.json({ error: 'rate_limited' }, 429);
    }
  } else {
    // Known limit: fail-open because a rate limiter is abuse mitigation, and a missing binding must not take TURN minting down.
    if (!warnedMissingRateLimiter) {
      warnedMissingRateLimiter = true;
      console.error('turn:no_rate_limiter');
    }
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const slug = (body as { slug?: unknown })?.slug;
  if (typeof slug !== 'string' || !isValidSlugFormat(slug)) {
    return c.json({ error: 'invalid_slug' }, 400);
  }
  const room = await getRoomBySlug(c.env.DB, slug);
  if (!room) return c.json({ error: 'not_found' }, 404);
  if (room.expires_at < Date.now()) return c.json({ error: 'expired' }, 404);

  let cred: TurnCredResponse;
  // Operator-supplied TURN wins. This is what makes "self-hostable" true rather
  // than aspirational: a deployment can depend on Cloudflare for nothing in the
  // media path. TURN relay is also the only metered resource in the stack, so
  // this is the escape hatch from the one line item that can grow a bill.
  const staticServers = parseStaticTurn(c.env);
  if (staticServers) {
    cred = staticServers;
  } else if (c.env.TURN_API_TOKEN && c.env.TURN_APP_ID) {
    try {
      cred = await mintCloudflareTurnCred(c.env);
    } catch {
      // Upstream TURN mint failed; surface a structured 502 rather than a bare 500.
      return c.json({ error: 'turn_unavailable' }, 502);
    }
  } else {
    cred = {
      urls: ['stun:stun.cloudflare.com:3478'],
      username: 'stub',
      credential: 'stub',
      ttl: TURN_CRED_TTL_S,
    };
  }

  const requestOrigin = c.req.header('Origin') ?? null;
  return new Response(JSON.stringify(cred), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(c.env.PAGES_ORIGIN, requestOrigin) },
  });
}

/**
 * Static ICE servers from config, or null when none are set.
 *
 * Credentials are optional: a STUN-only URL list is legitimate, and coturn can
 * be configured for either static long-term credentials or none at all.
 */
function parseStaticTurn(env: Env): TurnCredResponse | null {
  const raw = env.TURN_URLS?.trim();
  if (!raw) return null;
  const urls = raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) return null;
  return {
    urls,
    username: env.TURN_USERNAME ?? '',
    credential: env.TURN_CREDENTIAL ?? '',
    ttl: TURN_CRED_TTL_S,
  };
}

async function mintCloudflareTurnCred(env: Env): Promise<TurnCredResponse> {
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_APP_ID}/credentials/generate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TURN_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: TURN_CRED_TTL_S }),
  });
  if (!res.ok) {
    throw new Error(`turn cred mint failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    iceServers: { urls: string[]; username: string; credential: string };
  };
  return {
    urls: data.iceServers.urls,
    username: data.iceServers.username,
    credential: data.iceServers.credential,
    ttl: TURN_CRED_TTL_S,
  };
}

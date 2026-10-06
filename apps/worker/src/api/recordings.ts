import type { Context } from 'hono';
import type { Env } from '../env.js';
import { parseHostTokenCookie } from '../lib/cookie.js';
import { timingSafeEqualHex } from '../lib/token.js';
import {
  getRecordingById,
  getRoomBySlug,
  updateRecordingProgress,
  type RecordingRow,
} from '../db/queries.js';
import { corsHeaders } from '../lib/cors.js';

async function authRecording(
  c: Context<{ Bindings: Env }>,
  recId: string
): Promise<{ row: RecordingRow; slug: string } | Response> {
  const row = await getRecordingById(c.env.DB, recId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const sess = await c.env.DB.prepare('SELECT room_slug FROM sessions WHERE id = ?')
    .bind(row.session_id)
    .first<{ room_slug: string }>();
  if (!sess) return c.json({ error: 'session_missing' }, 404);
  const slug = sess.room_slug;
  const room = await getRoomBySlug(c.env.DB, slug);
  if (!room) return c.json({ error: 'room_missing' }, 404);
  // Host proves identity via either the httpOnly cookie (same-origin/local) or
  // an Authorization: Bearer <host_token> header (cross-origin deploys). Accept
  // if EITHER matches — a stale wrong cookie must not block a valid bearer.
  const cookie = parseHostTokenCookie(c.req.header('Cookie') ?? null, slug);
  const authz = c.req.header('Authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(authz.trim());
  const bearer = m ? m[1]! : null;
  const ok =
    (!!cookie && timingSafeEqualHex(cookie, room.host_token)) ||
    (!!bearer && timingSafeEqualHex(bearer, room.host_token));
  if (!ok) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return { row, slug };
}

export async function getRecording(c: Context<{ Bindings: Env }>): Promise<Response> {
  const recId = c.req.param('id');
  const auth = await authRecording(c, recId ?? '');
  if (auth instanceof Response) return auth;
  const requestOrigin = c.req.header('Origin') ?? null;
  return new Response(
    JSON.stringify({
      id: auth.row.id,
      last_offset: auth.row.last_offset,
      total_bytes: auth.row.total_bytes,
      status: auth.row.status,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(c.env.PAGES_ORIGIN, requestOrigin),
      },
    }
  );
}

export async function patchRecording(c: Context<{ Bindings: Env }>): Promise<Response> {
  const recId = c.req.param('id');
  const auth = await authRecording(c, recId ?? '');
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const update: Parameters<typeof updateRecordingProgress>[2] = {};

  if (b.total_bytes !== undefined) {
    if (typeof b.total_bytes !== 'number' || !Number.isSafeInteger(b.total_bytes) || b.total_bytes < 0) {
      return c.json({ error: 'invalid_field' }, 400);
    }
    update.total_bytes = b.total_bytes;
  }
  if (b.last_offset !== undefined) {
    if (typeof b.last_offset !== 'number' || !Number.isSafeInteger(b.last_offset) || b.last_offset < 0) {
      return c.json({ error: 'invalid_field' }, 400);
    }
    update.last_offset = b.last_offset;
  }
  if (b.sha256 !== undefined) {
    if (typeof b.sha256 !== 'string' || b.sha256.length > 64) {
      return c.json({ error: 'invalid_field' }, 400);
    }
    update.sha256 = b.sha256;
  }
  if (b.status !== undefined) {
    if (b.status !== 'recording' && b.status !== 'finalized') {
      return c.json({ error: 'invalid_field' }, 400);
    }
    update.status = b.status;
    if (b.status === 'finalized') {
      update.finalized_at = Date.now();
    }
  }

  await updateRecordingProgress(c.env.DB, auth.row.id, update);

  const requestOrigin = c.req.header('Origin') ?? null;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(c.env.PAGES_ORIGIN, requestOrigin),
    },
  });
}

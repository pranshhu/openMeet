import { Hono } from 'hono';
import type { Env } from './env.js';
import { postRooms, getRoomsSlug } from './api/rooms.js';
import { postTurnCred } from './api/turn.js';
import { getRecording, patchRecording } from './api/recordings.js';
import { getSponsors } from './api/sponsors.js';
import { corsHeaders, handlePreflight, isAllowedOrigin } from './lib/cors.js';
import { isValidSlugFormat } from './lib/slug.js';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const pre = handlePreflight(c.req.raw, c.env.PAGES_ORIGIN);
  if (pre) return pre;
  await next();
  // Apply CORS to every /api response — success AND error — so the browser can
  // read cross-origin replies. Per-handler spreads only covered the 2xx paths,
  // so 4xx (invalid_slug, not_found, unauthorized, …) were CORS-blocked. The
  // /ws path is excluded: its upgrade Response has immutable headers.
  if (c.req.path.startsWith('/api')) {
    const origin = c.req.header('Origin') ?? null;
    for (const [k, v] of Object.entries(corsHeaders(c.env.PAGES_ORIGIN, origin))) {
      c.res.headers.set(k, v);
    }
  }
});

app.get('/api/health', (c) => c.json({ ok: true, version: '0.1.0' }));
app.post('/api/rooms', postRooms);
app.get('/api/rooms/:slug', getRoomsSlug);
app.post('/api/turn-cred', postTurnCred);
app.get('/api/recordings/:id', getRecording);
app.patch('/api/recordings/:id', patchRecording);
app.get('/api/sponsors', getSponsors);

app.all('/ws/r/:slug', async (c) => {
  const slug = c.req.param('slug');
  // Validate BEFORE idFromName: every distinct name instantiates a Durable
  // Object, so an unvalidated path let anyone spin up unbounded DOs (each one
  // billable, and DO count is a free-tier limit) just by varying the URL.
  if (!isValidSlugFormat(slug)) return c.text('invalid slug', 400);
  // Browsers always send Origin on a WebSocket handshake and CORS does not
  // apply to it, so without this any site could open a socket into a room.
  // A missing Origin is not a browser (CLI tooling, tests) and stays allowed.
  const origin = c.req.header('Origin');
  if (origin !== undefined && !isAllowedOrigin(c.env.PAGES_ORIGIN, origin)) {
    return c.text('forbidden origin', 403);
  }
  const id = c.env.ROOM_DO.idFromName(slug);
  const stub = c.env.ROOM_DO.get(id);
  return stub.fetch(c.req.raw);
});

export default app;

export { Room } from './do/Room.js';

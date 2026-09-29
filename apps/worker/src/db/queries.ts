export interface RoomRow {
  slug: string;
  host_token: string;
  created_at: number;
  expires_at: number;
  consumed: number;
}

export interface SessionRow {
  id: string;
  room_slug: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

export interface ParticipantRow {
  id: string;
  session_id: string;
  role: string;
  display_name: string;
  joined_at: number;
  left_at: number | null;
  user_agent: string | null;
}

export interface RecordingRow {
  id: string;
  session_id: string;
  participant_id: string;
  kind: string;
  filename: string;
  total_bytes: number;
  last_offset: number;
  sha256: string | null;
  status: string;
  started_at: number;
  finalized_at: number | null;
}

export async function insertRoom(
  db: D1Database,
  row: Pick<RoomRow, 'slug' | 'host_token' | 'created_at' | 'expires_at'>
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO rooms (slug, host_token, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)'
    )
    .bind(row.slug, row.host_token, row.created_at, row.expires_at)
    .run();
}

export async function getRoomBySlug(db: D1Database, slug: string): Promise<RoomRow | null> {
  return await db.prepare('SELECT * FROM rooms WHERE slug = ?').bind(slug).first<RoomRow>();
}

export async function markRoomConsumed(db: D1Database, slug: string): Promise<void> {
  await db.prepare('UPDATE rooms SET consumed = 1 WHERE slug = ?').bind(slug).run();
}

/**
 * Sliding expiry: push a room's TTL out every time someone joins.
 *
 * A recurring show reuses one link, so a fixed 24h window would kill the room
 * between episodes. Rooms that stop being used still expire on their own, so
 * nothing accumulates forever.
 */
export async function touchRoom(db: D1Database, slug: string, expiresAt: number): Promise<void> {
  await db
    .prepare('UPDATE rooms SET expires_at = ? WHERE slug = ? AND expires_at < ?')
    .bind(expiresAt, slug, expiresAt)
    .run();
}

export async function insertSession(
  db: D1Database,
  row: Pick<SessionRow, 'id' | 'room_slug' | 'started_at'>
): Promise<void> {
  await db
    .prepare('INSERT INTO sessions (id, room_slug, started_at) VALUES (?, ?, ?)')
    .bind(row.id, row.room_slug, row.started_at)
    .run();
}

export async function endSession(
  db: D1Database,
  id: string,
  endedAt: number,
  reason: string
): Promise<void> {
  await db
    .prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL')
    .bind(endedAt, reason, id)
    .run();
}

export async function insertParticipant(db: D1Database, row: ParticipantRow): Promise<void> {
  await db
    .prepare(
      'INSERT INTO participants (id, session_id, role, display_name, joined_at, left_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      row.id,
      row.session_id,
      row.role,
      row.display_name,
      row.joined_at,
      row.left_at,
      row.user_agent
    )
    .run();
}

export async function markParticipantLeft(
  db: D1Database,
  id: string,
  leftAt: number
): Promise<void> {
  await db
    .prepare('UPDATE participants SET left_at = ? WHERE id = ? AND left_at IS NULL')
    .bind(leftAt, id)
    .run();
}

export async function insertRecording(db: D1Database, row: RecordingRow): Promise<void> {
  await db
    .prepare(
      'INSERT INTO recordings (id, session_id, participant_id, kind, filename, total_bytes, last_offset, sha256, status, started_at, finalized_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      row.id,
      row.session_id,
      row.participant_id,
      row.kind,
      row.filename,
      row.total_bytes,
      row.last_offset,
      row.sha256,
      row.status,
      row.started_at,
      row.finalized_at
    )
    .run();
}

export async function getRecordingById(
  db: D1Database,
  id: string
): Promise<RecordingRow | null> {
  return await db.prepare('SELECT * FROM recordings WHERE id = ?').bind(id).first<RecordingRow>();
}

export async function updateRecordingProgress(
  db: D1Database,
  id: string,
  fields: Partial<Pick<RecordingRow, 'total_bytes' | 'last_offset' | 'sha256' | 'status' | 'finalized_at'>>
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.total_bytes !== undefined) {
    sets.push('total_bytes = ?');
    vals.push(fields.total_bytes);
  }
  if (fields.last_offset !== undefined) {
    sets.push('last_offset = ?');
    vals.push(fields.last_offset);
  }
  if (fields.sha256 !== undefined) {
    sets.push('sha256 = ?');
    vals.push(fields.sha256);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    vals.push(fields.status);
  }
  if (fields.finalized_at !== undefined) {
    sets.push('finalized_at = ?');
    vals.push(fields.finalized_at);
  }
  if (sets.length === 0) return;
  vals.push(id);
  await db
    .prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...vals)
    .run();
}

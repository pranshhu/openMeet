-- 0001_init.sql

CREATE TABLE rooms (
  slug          TEXT PRIMARY KEY,
  host_token    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_rooms_expires ON rooms(expires_at);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  room_slug     TEXT NOT NULL REFERENCES rooms(slug),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  end_reason    TEXT
);
CREATE INDEX idx_sessions_room ON sessions(room_slug);

CREATE TABLE participants (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  role          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  joined_at     INTEGER NOT NULL,
  left_at       INTEGER,
  user_agent    TEXT
);
CREATE INDEX idx_participants_session ON participants(session_id);

CREATE TABLE recordings (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  participant_id  TEXT NOT NULL REFERENCES participants(id),
  kind            TEXT NOT NULL,
  filename        TEXT NOT NULL,
  total_bytes     INTEGER NOT NULL DEFAULT 0,
  last_offset     INTEGER NOT NULL DEFAULT 0,
  sha256          TEXT,
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  finalized_at    INTEGER
);
CREATE INDEX idx_recordings_session ON recordings(session_id);

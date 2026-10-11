import type { Role } from '@openmeet/protocol';
import { sanitizeText } from './sync-report';

/**
 * Lines one take keeps. A room holds five other connections at most; the rest
 * is for people who reconnect, each time under a new id.
 */
export const MAX_NOTICE_PEOPLE = 64;

/**
 * One connection, as the page holds it. Every field is read as untrusted: the
 * name is a participant's own text and the rest arrived in Room messages.
 */
export interface NoticePeer {
  peerId: unknown;
  name?: unknown;
  role?: unknown;
  companion?: unknown;
  notRecorded?: unknown;
}

/** One connection's line in the sync file. Times are offsets from the host's recording start. */
export interface NoticePerson {
  /** Null for a guest set as not recorded, and for a connection that gave no usable name. */
  name: string | null;
  role: Role | null;
  presentOnly?: true;
  setAsNotRecorded?: true;
  listedAtMs: number;
  confirmedAtMs: number | null;
}

/** The sync file's `recordingNotice` section. */
export interface NoticeRecord {
  note: string;
  announcedAtMs: number;
  people: NoticePerson[];
  capped?: true;
}

const NOTE =
  "What the host's browser knew about who was told that this take was being recorded. One line per connection, so a person who reconnected has more than one, and the host has none. Times are milliseconds after the host's recording start (timeline.hostStartUnixMs), on the host's clock. announcedAtMs: the host's browser issued the take's announcement to the room; this does not show that it arrived anywhere. listedAtMs: the host's browser had this connection in its list of the room. Equal to announcedAtMs, the connection was in that list as the announcement went out; later, it joined while the take was running, and this record cannot show whether the room told it. confirmedAtMs: a recording channel from this connection reached the host. openMeet's page opens one only after it was told that a take is running, and being told is what puts the recording notice on its screen, so this shows the page was told. null means none arrived: a producer, a present-only device that is not presenting, a guest set as not recorded and a browser that cannot record never open one, so for them this record shows only that they were listed. A guest set as not recorded is listed without a name. capped means the take had more connections than this record keeps. Nothing here shows that a person read the notice, that their tab was in front, or that their browser ran an unmodified page.";

interface Line {
  name: string | null;
  role: Role | null;
  presentOnly: boolean;
  notRecorded: boolean;
  listedAt: number;
  confirmedAt: number | null;
}

const isRole = (value: unknown): value is Role =>
  value === 'host' || value === 'guest' || value === 'producer';

/**
 * The host's record of who was told that one take was being recorded.
 *
 * It holds only what the host's page can know: who the room had listed when
 * the take was announced or while it ran, and whose recording channel then
 * arrived. Every time is the host's own clock; nothing a participant sends
 * carries one.
 */
export class NoticeLog {
  private readonly lines = new Map<string, Line>();
  private capped = false;

  /** `peers` is everyone the page lists as the take's announcement goes out, at `announcedAt`. */
  constructor(
    peers: readonly NoticePeer[],
    private readonly announcedAt: number
  ) {
    for (const peer of peers) this.listed(peer, announcedAt);
  }

  /** The room holds this connection while the take runs. Its line is written once. */
  listed(peer: NoticePeer, now: number): void {
    this.line(peer, now);
  }

  /** A recording channel of this take arrived from this connection. The first arrival stands. */
  confirmed(peer: NoticePeer, now: number): void {
    const line = this.line(peer, now);
    if (line && line.confirmedAt === null) line.confirmedAt = now;
  }

  /** The section for the sync file, every time as an offset from `hostStartMs` like the rest of that file. */
  record(hostStartMs: number): NoticeRecord {
    const at = (ms: number) => Math.max(0, Math.round(ms - hostStartMs));
    return {
      note: NOTE,
      announcedAtMs: at(this.announcedAt),
      people: [...this.lines.values()].map((line) => ({
        // Nothing of a guest set as not recorded is saved with a take: not
        // their chat, not their markers, and not their name here.
        name: line.notRecorded ? null : line.name,
        role: line.role,
        ...(line.presentOnly ? { presentOnly: true as const } : {}),
        ...(line.notRecorded ? { setAsNotRecorded: true as const } : {}),
        listedAtMs: at(line.listedAt),
        confirmedAtMs: line.confirmedAt === null ? null : at(line.confirmedAt),
      })),
      ...(this.capped ? { capped: true as const } : {}),
    };
  }

  private line(peer: NoticePeer, now: number): Line | undefined {
    const id = peer.peerId;
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) return undefined;
    let line = this.lines.get(id);
    if (!line) {
      if (this.lines.size >= MAX_NOTICE_PEOPLE) {
        this.capped = true;
        return undefined;
      }
      line = { name: null, role: null, presentOnly: false, notRecorded: false, listedAt: now, confirmedAt: null };
      this.lines.set(id, line);
    }
    // The page can list a connection before the room has said everything
    // about it, so a later look fills in what an earlier one lacked. What a
    // line already says is never changed back.
    if (peer.notRecorded === true) line.notRecorded = true;
    if (peer.companion === true) line.presentOnly = true;
    if (line.role === null && isRole(peer.role)) line.role = peer.role;
    if (line.name === null && typeof peer.name === 'string') {
      // Cut before it is cleaned, so a long name costs nothing to clean.
      line.name = sanitizeText(peer.name.slice(0, 200)).trim() || null;
    }
    return line;
  }
}

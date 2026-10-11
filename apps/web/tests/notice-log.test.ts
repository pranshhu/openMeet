import { describe, it, expect } from 'vitest';
import { MAX_NOTICE_PEOPLE, NoticeLog } from '@/lib/notice-log';
import { buildSyncReport } from '@/lib/sync-report';

const START = 1_000_000;

describe('NoticeLog', () => {
  it('lists everyone the room held at the announcement, and confirms only a connection whose channel arrived', () => {
    const log = new NoticeLog(
      [
        { peerId: 'p-bob', name: 'Bob', role: 'guest' },
        { peerId: 'p-pat', name: 'Pat', role: 'producer' },
        { peerId: 'p-cam', name: 'Cam', role: 'guest', companion: true },
      ],
      START + 40
    );
    log.confirmed({ peerId: 'p-bob', name: 'Bob', role: 'guest' }, START + 400);
    // A rebuilt channel is not a second telling.
    log.confirmed({ peerId: 'p-bob', name: 'Bob', role: 'guest' }, START + 9_000);

    const record = log.record(START);
    expect(record.announcedAtMs).toBe(40);
    expect(record.people).toEqual([
      { name: 'Bob', role: 'guest', listedAtMs: 40, confirmedAtMs: 400 },
      { name: 'Pat', role: 'producer', listedAtMs: 40, confirmedAtMs: null },
      { name: 'Cam', role: 'guest', presentOnly: true, listedAtMs: 40, confirmedAtMs: null },
    ]);
    expect(record.capped).toBeUndefined();
    expect(record.note).toContain('Nothing here shows that a person read the notice');
  });

  it('lists a connection that joins while the take runs from that moment, once', () => {
    const log = new NoticeLog([{ peerId: 'p-bob', name: 'Bob', role: 'guest' }], START + 40);
    log.listed({ peerId: 'p-dee', name: 'Dee', role: 'guest' }, START + 60_000);
    log.listed({ peerId: 'p-dee', name: 'Dee again', role: 'producer' }, START + 70_000);
    log.listed({ peerId: 'p-bob', name: 'Bob', role: 'guest' }, START + 70_000);

    expect(log.record(START).people).toEqual([
      { name: 'Bob', role: 'guest', listedAtMs: 40, confirmedAtMs: null },
      { name: 'Dee', role: 'guest', listedAtMs: 60_000, confirmedAtMs: null },
    ]);
  });

  it('writes no name for a guest set as not recorded, also when the room says so later', () => {
    const log = new NoticeLog([{ peerId: 'p-nora', name: 'Nora', role: 'guest', notRecorded: true }], START);
    log.listed({ peerId: 'p-omar', name: 'Omar' }, START + 100);
    expect(log.record(START).people).toEqual([
      { name: null, role: 'guest', setAsNotRecorded: true, listedAtMs: 0, confirmedAtMs: null },
      { name: 'Omar', role: null, listedAtMs: 100, confirmedAtMs: null },
    ]);

    log.listed({ peerId: 'p-omar', name: 'Omar', role: 'guest', notRecorded: true }, START + 200);
    expect(log.record(START).people[1]).toEqual({
      name: null,
      role: 'guest',
      setAsNotRecorded: true,
      listedAtMs: 100,
      confirmedAtMs: null,
    });
  });

  it('gives a line to a connection whose channel arrives before the page listed it', () => {
    const log = new NoticeLog([], START);
    log.confirmed({ peerId: 'p-eve', name: 'Eve', role: 'guest' }, START + 500);
    expect(log.record(START).people).toEqual([
      { name: 'Eve', role: 'guest', listedAtMs: 500, confirmedAtMs: 500 },
    ]);
  });

  it('writes no negative offset for a time before the host started', () => {
    const log = new NoticeLog([{ peerId: 'p-bob', name: 'Bob', role: 'guest' }], START);
    log.confirmed({ peerId: 'p-bob' }, START - 5);
    expect(log.record(START + 10)).toMatchObject({
      announcedAtMs: 0,
      people: [{ listedAtMs: 0, confirmedAtMs: 0 }],
    });
  });

  it('takes nothing on trust from a name, a role or an id', () => {
    const log = new NoticeLog(
      [
        { peerId: 'p-1', name: 'A‮b\u0000c  ', role: 'admin', companion: 'yes', notRecorded: 'yes' },
        { peerId: 'p-2', name: 'x'.repeat(500), role: 'guest' },
        { peerId: 'p-3', name: { toString: () => { throw new Error('not text'); } }, role: 'guest' },
        { peerId: 'p-4', name: ' ‎ ', role: 'guest' },
        { peerId: 7, name: 'A number for an id', role: 'guest' },
        { peerId: '', name: 'No id', role: 'guest' },
        { peerId: 'i'.repeat(65), name: 'An id too long', role: 'guest' },
      ],
      START
    );
    const people = log.record(START).people;
    expect(people).toHaveLength(4);
    expect(people[0]).toEqual({ name: 'A b c', role: null, listedAtMs: 0, confirmedAtMs: null });
    expect(people[1]!.name).toHaveLength(200);
    expect(people[2]!.name).toBeNull();
    expect(people[3]!.name).toBeNull();
  });

  it('stops at its limit and says so, without losing a line it already has', () => {
    const log = new NoticeLog([{ peerId: 'p-bob', name: 'Bob', role: 'guest' }], START);
    for (let i = 1; i < MAX_NOTICE_PEOPLE + 5; i += 1) {
      log.listed({ peerId: `p-${i}`, name: `G${i}`, role: 'guest' }, START + i);
    }
    log.confirmed({ peerId: 'p-bob' }, START + 900);
    log.confirmed({ peerId: 'p-late' }, START + 950);

    const record = log.record(START);
    expect(record.people).toHaveLength(MAX_NOTICE_PEOPLE);
    expect(record.capped).toBe(true);
    expect(record.people[0]).toMatchObject({ name: 'Bob', confirmedAtMs: 900 });
  });
});

describe('the sync file and the record of who was told', () => {
  const base = { recordingId: 'rec', hostFile: 'host_rec.mp4', hostStartMs: START, guests: [] };

  it('carries the record as recordingNotice', () => {
    const recordingNotice = new NoticeLog([{ peerId: 'p-bob', name: 'Bob', role: 'guest' }], START + 40).record(START);
    const json = JSON.parse(buildSyncReport({ ...base, recordingNotice }).json);
    expect(json.recordingNotice).toEqual(recordingNotice);
  });

  it('has no such section for a take that has no record', () => {
    expect('recordingNotice' in JSON.parse(buildSyncReport(base).json)).toBe(false);
    expect('recordingNotice' in JSON.parse(buildSyncReport({ ...base, recordingNotice: undefined }).json)).toBe(false);
  });
});

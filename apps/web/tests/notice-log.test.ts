import { describe, it, expect } from 'vitest';
import { MAX_NOTICE_PEOPLE, NoticeLog, crashCopyNotice, peopleFromNotes } from '@/lib/notice-log';
import { buildSyncReport } from '@/lib/sync-report';
import type { JournalFileNote } from '@/lib/take-journal';

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
        { peerId: 'p-1', name: 'A\u202Eb\u0000c  ', role: 'admin', companion: 'yes', notRecorded: 'yes' },
        { peerId: 'p-2', name: 'x'.repeat(500), role: 'guest' },
        { peerId: 'p-3', name: { toString: () => { throw new Error('not text'); } }, role: 'guest' },
        { peerId: 'p-4', name: ' \u200E ', role: 'guest' },
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

describe('the record of who was told, after an interrupted take', () => {
  const files: JournalFileNote[] = [
    // Opened at Record and never bound: no guest's channel reached it.
    { file: 'guest_r.mp4', kind: 'camera', slot: 0 },
    { file: 'guest2_r.mp4', kind: 'camera', slot: 1, key: 'K2', who: ' Bob\u0000 ' },
    { file: 'guest2_r.wav', kind: 'wav', slot: 1, key: 'K2', who: 'Bob' },
    { file: 'guest3_r.mp4', kind: 'camera', slot: 2, key: 'K3' },
    { file: 'guest_screen_r.mp4', kind: 'screen', segment: 1, who: 'Cam' },
  ];

  it('names a guest for each camera file a channel was bound to, and nobody else', () => {
    expect(peopleFromNotes(files)).toEqual([
      { name: 'Bob', file: 'guest2_r.mp4' },
      { name: null, file: 'guest3_r.mp4' },
    ]);
  });

  it('names no more guests than the record keeps lines for, and no more than 200 characters of a name', () => {
    const many: JournalFileNote[] = Array.from({ length: MAX_NOTICE_PEOPLE + 6 }, (_, i) => ({
      file: `guest${i + 1}_r.mp4`,
      kind: 'camera' as const,
      slot: i,
      key: `K${i}`,
    }));
    expect(peopleFromNotes(many)).toHaveLength(MAX_NOTICE_PEOPLE);
    const [long] = peopleFromNotes([{ file: 'guest_r.mp4', kind: 'camera', slot: 0, key: 'K1', who: 'x'.repeat(500) }]);
    expect(long!.name).toHaveLength(200);
  });

  it('gives a take saved from its crash copy that list and no times', () => {
    const notice = crashCopyNotice(files);
    expect(notice.people).toEqual([]);
    expect('announcedAtMs' in notice).toBe(false);
    expect(notice.fromCrashCopy).toEqual(peopleFromNotes(files));
    expect(notice.note).toContain('keeps no record of who was told');
  });

  it('marks a resumed take and keeps that list beside the lines written after the resume', () => {
    const before = peopleFromNotes(files);
    const record = new NoticeLog([{ peerId: 'p-bob', name: 'Bob', role: 'guest' }], START + 95_000, before).record(START);
    expect(record.resumed).toBe(true);
    expect(record.fromCrashCopy).toEqual(before);
    expect(record.announcedAtMs).toBe(95_000);
    expect(record.people).toEqual([{ name: 'Bob', role: 'guest', listedAtMs: 95_000, confirmedAtMs: null }]);
    expect(record.note).toContain('Nothing here shows that a person read the notice');
    expect(record.note).toContain('then resumed from');

    // A take that was never interrupted says none of it.
    const plain = new NoticeLog([], START).record(START);
    expect('resumed' in plain).toBe(false);
    expect('fromCrashCopy' in plain).toBe(false);
    expect(plain.note).not.toContain('then resumed from');
  });
});

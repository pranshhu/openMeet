import { describe, it, expect, vi } from 'vitest';
import { clockSection } from '@/lib/clock-drift';
import { buildSyncReport } from '@/lib/sync-report';
import { ChunkReceiver } from '@/lib/chunk-receiver';
import { collectGuestReports, type RecordingHandles } from '@/hooks/recording-controller';

const HOST_START = 1_000_000;
const guest = {
  slot: 0,
  file: 'guest_r.mp4',
  startHostMs: HOST_START + 2500,
  rttMs: 30,
  clockAtMs: HOST_START + 2600,
};
const end = { startHostMs: HOST_START + 2504, rttMs: 24, atMs: HOST_START + 3_482_600 };
const START = { offsetMs: 2500, rttMs: 30, measuredAtMs: 2600 };
const MOVED = {
  end: { offsetMs: 2504, rttMs: 24, measuredAtMs: 3_482_600 },
  movedMs: 4,
  // Half of 30 + 24, plus 4 ms for the clocks' whole-millisecond steps.
  errorMs: 31,
  spanMs: 3_480_000,
};

describe('clockSection', () => {
  it('lists the first estimate with when it was taken, and nothing about movement without a second one', () => {
    expect(clockSection(HOST_START, [guest])?.guests).toEqual([
      { slot: 0, file: 'guest_r.mp4', start: START },
    ]);
  });

  it('says how far the clocks moved between two estimates, over how long and within what error', () => {
    expect(clockSection(HOST_START, [{ ...guest, name: 'Ana', clockEnd: end }])?.guests).toEqual([
      { slot: 0, name: 'Ana', file: 'guest_r.mp4', start: START, ...MOVED },
    ]);
  });

  it('writes nothing about movement when an error cannot be stated or the order is wrong', () => {
    const entry = (over: object) => clockSection(HOST_START, [{ ...guest, ...over } as never])!.guests[0]!;
    // No round trip on the first estimate: no error to state.
    expect(entry({ rttMs: null, clockEnd: end })).toEqual({
      slot: 0,
      file: 'guest_r.mp4',
      start: { ...START, rttMs: null },
    });
    // The first estimate's time was not kept: no span.
    expect('end' in entry({ clockAtMs: null, clockEnd: end })).toBe(false);
    // A second estimate dated before the first.
    expect('end' in entry({ clockEnd: { ...end, atMs: HOST_START } })).toBe(false);
    // Numbers that are not numbers.
    for (const bad of [
      { ...end, startHostMs: NaN },
      { ...end, rttMs: -1 },
      { ...end, rttMs: Infinity },
      { ...end, atMs: '5' },
    ]) {
      expect('end' in entry({ clockEnd: bad })).toBe(false);
      expect('movedMs' in entry({ clockEnd: bad })).toBe(false);
    }
  });

  it('lists only the guests that have an estimate, and is absent when none has', () => {
    const none = { slot: 1, file: 'guest2_r.mp4', startHostMs: null, rttMs: null };
    expect(clockSection(HOST_START, [none])).toBeNull();
    expect(clockSection(HOST_START, [])).toBeNull();
    expect(clockSection(HOST_START, [none, guest])!.guests.map((g) => g.slot)).toEqual([0]);
  });
});

describe('buildSyncReport: the clock section', () => {
  const base = { recordingId: 'r', hostFile: 'host_r.mp4', hostStartMs: HOST_START };

  it('carries the section with the name cleaned, and a second estimate moves no offset', () => {
    const j = JSON.parse(buildSyncReport({ ...base, guests: [{ ...guest, name: ' Ana\n', clockEnd: end }] }).json);
    expect(j.clock.guests).toEqual([
      { slot: 0, name: 'Ana', file: 'guest_r.mp4', start: START, ...MOVED },
    ]);
    expect(j.clock.note).toContain('not a measurement of how the audio or video inside a file keeps time');
    expect(j.timeline.guestMinusHostMs).toBe(2500);
    expect(j.guests[0].offsetMs).toBe(2500);
  });

  it('has no clock key when no guest has an estimate', () => {
    const unsynced = { slot: 0, file: 'guest_r.mp4', startHostMs: null, rttMs: null };
    expect('clock' in JSON.parse(buildSyncReport({ ...base, guests: [unsynced] }).json)).toBe(false);
    expect('clock' in JSON.parse(buildSyncReport({ ...base, guests: [] }).json)).toBe(false);
  });

  it('writes the report without the section when the section cannot be built', () => {
    const broken = {
      ...guest,
      get clockEnd(): never {
        throw new Error('not readable');
      },
    };
    const j = JSON.parse(buildSyncReport({ ...base, guests: [broken] }).json);
    expect('clock' in j).toBe(false);
    expect(j.guests[0].offsetMs).toBe(2500);
  });
});

describe('ChunkReceiver: the first clock report stands, a later one is kept beside it', () => {
  const receiver = (onMeta?: (meta: unknown) => void) =>
    new ChunkReceiver({
      recordingId: 'r',
      writer: { write: vi.fn().mockResolvedValue(undefined), fileName: 'guest_r.mp4' } as never,
      sendControl: vi.fn(),
      ...(onMeta ? { onMeta } : {}),
    });
  const meta = (r: ChunkReceiver, fields: object) =>
    r.handleMessage(JSON.stringify({ type: 'recording_meta', recordingId: 'r', ...fields }));

  it('keeps the first start, stamps when it came, and keeps a later one without moving the first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const r = receiver();
      expect(r.clockAtMs).toBeNull();
      expect(r.clockEnd).toBeNull();

      const t0 = Date.now();
      await meta(r, { guestStartHostMs: t0 - 500, rttMs: 30 });
      expect(r.clockAtMs).toBe(t0);
      expect(r.clockEnd).toBeNull();

      vi.setSystemTime(t0 + 60_000);
      await meta(r, { guestStartHostMs: t0 - 496, rttMs: 24 });
      expect(r.guestStartHostMs).toBe(t0 - 500);
      expect(r.syncRttMs).toBe(30);
      expect(r.clockAtMs).toBe(t0);
      expect(r.clockEnd).toEqual({ startHostMs: t0 - 496, rttMs: 24, atMs: t0 + 60_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the latest of several later reports, and none it has no round trip for', async () => {
    const r = receiver();
    const t = Date.now();
    await meta(r, { guestStartHostMs: t - 500, rttMs: 30 });
    await meta(r, { guestStartHostMs: t - 400 });
    await meta(r, { guestStartHostMs: t - 400, rttMs: -5 });
    await meta(r, { guestStartHostMs: t - 400, rttMs: 'fast' });
    expect(r.clockEnd).toBeNull();

    await meta(r, { guestStartHostMs: t - 498, rttMs: 20 });
    await meta(r, { guestStartHostMs: t - 497, rttMs: 22 });
    expect(r.clockEnd).toMatchObject({ startHostMs: t - 497, rttMs: 22 });
    expect(r.guestStartHostMs).toBe(t - 500);
    expect(r.syncRttMs).toBe(30);
  });

  it('hands onMeta the first start only', async () => {
    const onMeta = vi.fn();
    const r = receiver(onMeta);
    const t = Date.now();
    await meta(r, { guestStartHostMs: t - 500, rttMs: 30 });
    await meta(r, { guestStartHostMs: t - 400, rttMs: 20 });
    expect(onMeta).toHaveBeenCalledTimes(1);
    expect(onMeta).toHaveBeenLastCalledWith({ guestStartHostMs: t - 500, rttMs: 30 });
  });
});

describe('collectGuestReports: the clock readings reach the report', () => {
  it('hands over when the first estimate came and the later one, for the first guest and for another', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const writer = (fileName: string) =>
        ({ write: vi.fn().mockResolvedValue(undefined), fileName, size: 0 }) as never;
      const make = (fileName: string) =>
        new ChunkReceiver({ recordingId: 'r', writer: writer(fileName), sendControl: vi.fn() });
      const first = make('guest_r.mp4');
      const second = make('guest2_r.mp4');
      const t = Date.now();
      for (const r of [first, second]) {
        await r.handleMessage(
          JSON.stringify({ type: 'recording_meta', recordingId: 'g', guestStartHostMs: t - 500, rttMs: 30 })
        );
      }
      vi.setSystemTime(t + 60_000);
      for (const r of [first, second]) {
        await r.handleMessage(
          JSON.stringify({ type: 'recording_meta', recordingId: 'g', guestStartHostMs: t - 496, rttMs: 24 })
        );
      }

      const h: RecordingHandles = {
        recordingId: 'r',
        receiver: first,
        guestWriter: writer('guest_r.mp4'),
        // A channel was bound to the first guest's file, so it is reported.
        channelRef: { current: {} as RTCDataChannel },
        guestSlots: new Map([
          ['k1', 0],
          ['k2', 1],
        ]),
        guestReceivers: new Map([
          ['k2:mp4', { receiver: second, ref: { current: null }, writer: writer('guest2_r.mp4') }],
        ]),
      };

      const reports = await collectGuestReports(h);
      expect(reports.map((g) => [g.slot, g.file, g.startHostMs, g.clockAtMs])).toEqual([
        [0, 'guest_r.mp4', t - 500, t],
        [1, 'guest2_r.mp4', t - 500, t],
      ]);
      expect(reports.map((g) => g.clockEnd)).toEqual([
        { startHostMs: t - 496, rttMs: 24, atMs: t + 60_000 },
        { startHostMs: t - 496, rttMs: 24, atMs: t + 60_000 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

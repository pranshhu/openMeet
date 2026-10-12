import { describe, it, expect, vi, afterEach } from 'vitest';
import { clockSection } from '@/lib/clock-drift';
import { ClockSync } from '@/lib/clock-sync';
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

  it('writes nothing about movement when the first round trip is below zero', () => {
    const entry = clockSection(HOST_START, [{ ...guest, rttMs: -1000, clockEnd: end }])!.guests[0]!;
    expect(entry).toEqual({ slot: 0, file: 'guest_r.mp4', start: { ...START, rttMs: null } });
  });

  it('writes nothing about movement when the second time is a number in a string', () => {
    const late = { ...end, atMs: String(end.atMs) };
    const entry = clockSection(HOST_START, [{ ...guest, clockEnd: late } as never])!.guests[0]!;
    expect('end' in entry).toBe(false);
    expect('movedMs' in entry).toBe(false);
  });

  it('does not list a guest whose start is not a number', () => {
    expect(clockSection(HOST_START, [{ ...guest, startHostMs: NaN }])).toBeNull();
    expect(clockSection(HOST_START, [{ ...guest, startHostMs: undefined } as never])).toBeNull();
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

  it('keeps no later report whose round trip is not a number, and lets it replace none', async () => {
    const r = receiver();
    const t = Date.now();
    await meta(r, { guestStartHostMs: t - 500, rttMs: 30 });
    await meta(r, { guestStartHostMs: t - 400, rttMs: '20' });
    await meta(r, { guestStartHostMs: t - 400, rttMs: null });
    await meta(r, { guestStartHostMs: t - 400, rttMs: true });
    expect(r.clockEnd).toBeNull();

    await meta(r, { guestStartHostMs: t - 498, rttMs: 20 });
    await meta(r, { guestStartHostMs: t - 400, rttMs: '9' });
    expect(r.clockEnd).toMatchObject({ startHostMs: t - 498, rttMs: 20 });
  });

  it('keeps the round trip that came with the first start when a later report brings no start it can take', async () => {
    const onMeta = vi.fn();
    const r = receiver(onMeta);
    const t = Date.now();
    await meta(r, { guestStartHostMs: t - 500, rttMs: 30 });
    // A start later than the host's clock is no start, and its round trip is another exchange's.
    await meta(r, { guestStartHostMs: t + 3_600_000, rttMs: 7 });
    await meta(r, { guestStartHostMs: null, rttMs: 9 });
    await meta(r, { rttMs: 0 });
    expect(r.guestStartHostMs).toBe(t - 500);
    expect(r.syncRttMs).toBe(30);
    expect(r.clockEnd).toBeNull();
    expect(onMeta).toHaveBeenCalledTimes(1);
    expect(onMeta).toHaveBeenLastCalledWith({ guestStartHostMs: t - 500, rttMs: 30 });
  });

  it('takes the round trip a first start comes with over one reported alone before it', async () => {
    const r = receiver();
    const t = Date.now();
    await meta(r, { rttMs: 9 });
    expect(r.syncRttMs).toBe(9);
    await meta(r, { guestStartHostMs: t - 500, rttMs: 30 });
    expect(r.syncRttMs).toBe(30);
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

describe('ChunkReceiver: seeded with the estimate a crash copy holds', () => {
  const seeded = (clockFrom: object) =>
    new ChunkReceiver({
      recordingId: 'r',
      writer: { write: vi.fn().mockResolvedValue(undefined), fileName: 'guest_r.mp4' } as never,
      sendControl: vi.fn(),
      clockFrom: clockFrom as never,
    });
  const held = (r: ChunkReceiver) => [r.guestStartHostMs, r.syncRttMs, r.clockAtMs];

  it('holds the seeded estimate as the first, so a report that arrives is the later one', async () => {
    const t = Date.now();
    const r = seeded({ guestStartHostMs: t - 5000, rttMs: 12, atMs: t - 4800 });
    expect(held(r)).toEqual([t - 5000, 12, t - 4800]);

    await r.handleMessage(
      JSON.stringify({ type: 'recording_meta', recordingId: 'g', guestStartHostMs: t - 4997, rttMs: 20 })
    );
    expect(held(r)).toEqual([t - 5000, 12, t - 4800]);
    expect(r.clockEnd).toMatchObject({ startHostMs: t - 4997, rttMs: 20 });
  });

  it('seeds nothing without a start that is a number, and no round trip or time that is not one', () => {
    for (const bad of [{}, { guestStartHostMs: null, rttMs: 12, atMs: 5 }, { guestStartHostMs: 'x' }, { guestStartHostMs: NaN }]) {
      expect(held(seeded(bad))).toEqual([null, null, null]);
    }
    expect(held(seeded({ guestStartHostMs: 1000, rttMs: 'fast', atMs: Infinity }))).toEqual([1000, null, null]);
  });
});

describe('a computer clock that is set during the take, as the clock section shows it', () => {
  afterEach(() => vi.useRealTimers());

  const SET = 5000;
  const HOUR = 3_600_000;

  type Change = { host?: number; guest?: number; lag?: number };

  /**
   * A guest's clock sync wired to the host's receiver over a link that takes
   * `lag` ms each way. `t` is the true time, `host` and `guest` are how far
   * each computer's clock is from it, and both recordings start together.
   */
  const take = () => {
    vi.useFakeTimers();
    const clock = { t: 1_700_000_000_000, host: 0, guest: 0, lag: 10 };
    const pass = (ms: number) => {
      clock.t += ms;
      vi.setSystemTime(clock.t + clock.host);
    };
    const set = (change: Change) => {
      clock.host += change.host ?? 0;
      clock.guest += change.guest ?? 0;
      clock.lag = change.lag ?? clock.lag;
      pass(0);
    };
    // A change made while an answer is on its way back to the guest.
    let onTheWay: { skip: number; change: Change } | null = null;
    pass(0);
    const hostStart = Date.now();
    const sync: ClockSync = new ClockSync({
      recordingId: 'r',
      guestStartMs: clock.t + clock.guest,
      now: () => clock.t + clock.guest,
      send: (json) => {
        pass(clock.lag);
        void r.handleMessage(json);
      },
    });
    const r = new ChunkReceiver({
      recordingId: 'r',
      writer: { write: vi.fn().mockResolvedValue(undefined), fileName: 'guest_r.mp4' } as never,
      sendControl: (json) => {
        pass(clock.lag);
        if (onTheWay && onTheWay.skip-- === 0) set(onTheWay.change);
        sync.handlePong(JSON.parse(json));
      },
    });
    const section = () =>
      clockSection(hostStart, [
        {
          slot: 0,
          file: 'guest_r.mp4',
          startHostMs: r.guestStartHostMs,
          rttMs: r.syncRttMs,
          clockAtMs: r.clockAtMs,
          clockEnd: r.clockEnd ?? undefined,
        },
      ]);
    return {
      set,
      pass,
      sync,
      section,
      /** Make `change` during the answer that follows `skip` others. */
      setDuringAnswer: (skip: number, change: Change) => {
        onTheWay = { skip, change };
      },
    };
  };

  /** Three minutes of take with `change` made after two of them, between the two estimates. */
  const setMidTake = async (change: Change) => {
    const { set, pass, sync, section } = take();
    await sync.run();
    pass(120_000);
    set(change);
    pass(60_000);
    await sync.again();
    return section()!.guests[0]!;
  };

  const START_ONLY = { slot: 0, file: 'guest_r.mp4', start: { offsetMs: 0, rttMs: 20, measuredAtMs: 110 } };

  it.each([
    ['the guest clock forward', { guest: SET }, -SET],
    ['the guest clock back by less than its recording has run', { guest: -SET }, SET],
    ['the host clock forward', { host: SET }, SET],
    ['the host clock back by less than the time between the estimates', { host: -SET }, -SET],
  ])('%s shows as a movedMs of that size, and moves no guest offset', async (_name, change, movedMs) => {
    expect(await setMidTake(change)).toMatchObject({ ...START_ONLY, movedMs, errorMs: 24 });
  });

  it('the guest clock back by more than its recording has run leaves no end, and moves no guest offset', async () => {
    // The link is faster by then, and the round trip listed is the first exchange's.
    expect(await setMidTake({ guest: -HOUR, lag: 7 })).toEqual(START_ONLY);
  });

  it('the host clock back by more than the time between the estimates leaves no end, and moves no guest offset', async () => {
    expect(await setMidTake({ host: -HOUR })).toEqual(START_ONLY);
  });

  it('the guest clock set back during an exchange keeps the estimate from before it', async () => {
    // In the first round, during its second answer: the start is the first sample's.
    const first = take();
    first.setDuringAnswer(1, { guest: -SET });
    await first.sync.run();
    first.pass(180_000);
    await first.sync.again();
    expect(first.section()!.guests[0]).toMatchObject({
      start: { offsetMs: 0, rttMs: 20, measuredAtMs: 50 },
      movedMs: SET,
      errorMs: 24,
    });

    // In the round at the stop, during its second answer: the end is its first sample's.
    const last = take();
    await last.sync.run();
    last.pass(180_000);
    last.setDuringAnswer(1, { guest: -SET });
    await last.sync.again();
    expect(last.section()!.guests[0]).toMatchObject({ ...START_ONLY, movedMs: 0, errorMs: 24 });
  });

  it('the guest clock set back during its first exchange leaves that guest with no estimate', async () => {
    const { setDuringAnswer, pass, sync, section } = take();
    setDuringAnswer(0, { guest: -SET });
    await sync.run();
    pass(180_000);
    // Nothing measured from here on places the start, so nothing is taken at the stop either.
    await sync.again();
    expect(section()).toBeNull();
  });

  it('a clock set before the first estimate, unseen, moves the offset, and the note says so', async () => {
    // Both recordings started together, so the true offset is 0.
    for (const [change, offsetMs] of [
      [{ guest: -SET }, SET],
      [{ guest: SET }, -SET],
      [{ host: SET }, SET],
      [{ host: -SET }, -SET],
    ] as const) {
      const { set, pass, sync, section } = take();
      // Ten seconds in, between two rounds of pings, with no answer before it.
      pass(8000);
      set(change);
      pass(2000);
      await sync.run();
      pass(180_000);
      await sync.again();
      expect(section()!.guests[0]).toMatchObject({ start: { offsetMs, rttMs: 20 }, movedMs: 0 });
    }

    const note = clockSection(HOST_START, [guest])!.note;
    expect(note).toContain('shows as a movedMs of about the size of the change, or as a guest with no end');
    expect(note).toContain('saw its own clock set back before it had an estimate takes none');
    expect(note).toContain("moves that guest's offsets by up to the size of the change, and nothing here shows it");
    expect(note).not.toContain('shows as a large movedMs');
  });

  it('the note keeps a clock set between two estimates to the camera file and WAV, and says what to do', () => {
    const note = clockSection(HOST_START, [guest])!.note;
    expect(note).toContain(
      "does not move the offset of that guest's camera file and WAV, which comes from the start estimate"
    );
    expect(note).toContain(
      'A guest with no end has no usable second estimate, and a guest that is not listed has no usable estimate at all'
    );
    expect(note).toContain('Align by waveform a clip that sits wrong by a second or more.');
  });
});

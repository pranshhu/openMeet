import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import { chooseTitle } from '@/lib/name-tag';
import { buildSyncReport, type SyncReportInput } from '@/lib/sync-report';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
const second = vi.hoisted(() => ({ on: false }));

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ urls: [], username: 'u', credential: 'c', ttl: 100 }),
  getRoom: vi.fn().mockResolvedValue({ slug: 'abc-defg-hij', expires_at: Date.now() + 10000 }),
  patchRecording: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
    reconnect: vi.fn(),
    on: vi.fn((type: string, handler: (m: any) => void) => {
      (signalHandlers[type] ??= []).push(handler);
    }),
  })),
}));

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    close: vi.fn(),
    setLocalStream: vi.fn(),
    setLocalStreamAfterFirstOffer: vi.fn(),
    replaceAudioTrack: vi.fn(),
    createControlChannel: vi.fn(),
    addTransceiver: vi.fn(),
    addTrack: vi.fn(),
    restartIce: vi.fn(),
    connectionState: 'connected',
    rawConnection: null,
    whenConnected: vi.fn().mockResolvedValue(undefined),
    setPeerCount: vi.fn(),
  })),
  ConnectionTimeoutError: class extends Error {},
}));

// The two ends of a host take: one guest file, in slot 0, bound to the peer 'p-guest'.
vi.mock('@/hooks/recording-controller', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/recording-controller')>(
    '@/hooks/recording-controller'
  );
  return {
    ...actual,
    startHostRecording: vi.fn().mockImplementation(async () => ({
      recordingId: 'rec-host-1',
      hostStartMs: 1_000_000,
      hostWriter: { fileName: 'host_rec-host-1.mp4', size: 1 },
      receiver: {
        fileName: 'guest_rec-host-1.mp4',
        digestHex: async () => 'abc',
        senderSha256: 'abc',
        receivedFinalized: true,
        isAbandoned: false,
        bytesWritten: 1,
      },
      slotPeerIds: new Map([[0, 'p-guest'], ...(second.on ? [[1, 'p-guest-2'] as [number, string]] : [])]),
      ...(second.on
        ? {
            guestSlots: new Map([['key-2', 1]]),
            guestReceivers: new Map([
              [
                'key-2:mp4',
                {
                  receiver: {
                    digestHex: async () => 'def',
                    receivedFinalized: true,
                    isAbandoned: false,
                    bytesWritten: 1,
                    flushAck: () => {},
                  },
                  ref: { current: null },
                  writer: { fileName: 'guest2_rec-host-1.mp4', size: 1 },
                },
              ],
            ]),
          }
        : {}),
    })),
    endHostRecording: vi.fn().mockResolvedValue({ backup: null }),
  };
});

const take: SyncReportInput = {
  recordingId: 'rec',
  hostFile: 'host-ana_rec.mp4',
  hostWavFile: 'host-ana_rec.wav',
  hostStartMs: 1000,
  guests: [
    { slot: 0, name: 'Bob', file: 'guest_rec.mp4', wavFile: 'guest_rec.wav', startHostMs: 1500, rttMs: 10 },
    { slot: 1, name: 'Carol', file: 'guest2_rec.mp4', startHostMs: 1600, rttMs: 10 },
  ],
};

type Json = { nameTags?: { note: string; people: Record<string, unknown>[] } } & Record<string, unknown>;

const jsonOf = (input: SyncReportInput) => JSON.parse(buildSyncReport(input).json) as Json;

describe('buildSyncReport: name tags', () => {
  it('lists the host and each guest with their name, title and files', () => {
    const json = jsonOf({
      ...take,
      nameTags: {
        hostName: 'Ana',
        hostTitle: 'Founder, Acme',
        slotTitles: new Map([
          [0, 'Author'],
          [1, 'Editor'],
        ]),
      },
    });
    expect(json.nameTags?.note).toBe(
      "Each recorded person's name and title as their tile showed them in the call. Nothing is drawn into the video files; use these for lower thirds."
    );
    expect(json.nameTags?.people).toEqual([
      { role: 'host', name: 'Ana', title: 'Founder, Acme', files: ['host-ana_rec.mp4', 'host-ana_rec.wav'] },
      { role: 'guest', slot: 0, name: 'Bob', title: 'Author', files: ['guest_rec.mp4', 'guest_rec.wav'] },
      { role: 'guest', slot: 1, name: 'Carol', title: 'Editor', files: ['guest2_rec.mp4'] },
    ]);
  });

  it('lists the guests in slot order and leaves out a name or title that is not there', () => {
    const json = jsonOf({
      ...take,
      guests: [...take.guests].reverse().map((g) => (g.slot === 1 ? { ...g, name: undefined } : g)),
      nameTags: { hostTitle: 'Founder', slotTitles: new Map([[1, 'Editor']]) },
    });
    expect(json.nameTags?.people).toEqual([
      { role: 'host', title: 'Founder', files: ['host-ana_rec.mp4', 'host-ana_rec.wav'] },
      { role: 'guest', slot: 0, name: 'Bob', files: ['guest_rec.mp4', 'guest_rec.wav'] },
      { role: 'guest', slot: 1, title: 'Editor', files: ['guest2_rec.mp4'] },
    ]);
  });

  it("lists each of a resumed take's host files once", () => {
    const json = jsonOf({
      ...take,
      resumed: true,
      hostParts: [
        { name: 'host-ana_rec_part1.mp4', offsetMs: 0, kind: 'camera' },
        { name: 'host-ana_rec_part1.wav', offsetMs: 0, kind: 'wav' },
        { name: 'host-ana_rec.mp4', offsetMs: 5000, kind: 'camera' },
        { name: 'host-ana_rec.wav', offsetMs: 5000, kind: 'wav' },
      ],
      nameTags: { hostName: 'Ana', hostTitle: 'Founder' },
    });
    expect(json.nameTags?.people[0]?.files).toEqual([
      'host-ana_rec.mp4',
      'host-ana_rec.wav',
      'host-ana_rec_part1.mp4',
      'host-ana_rec_part1.wav',
    ]);
  });

  it('lists the host when only a WAV was written, and not at all when nothing of the host was', () => {
    const wavOnly = jsonOf({ ...take, hostFile: undefined, nameTags: { hostName: 'Ana', hostTitle: 'Founder' } });
    expect(wavOnly.nameTags?.people[0]).toEqual({
      role: 'host',
      name: 'Ana',
      title: 'Founder',
      files: ['host-ana_rec.wav'],
    });
    const none = jsonOf({
      ...take,
      hostFile: undefined,
      hostWavFile: undefined,
      nameTags: { hostName: 'Ana', hostTitle: 'Founder', slotTitles: new Map([[0, 'Author']]) },
    });
    expect(none.nameTags?.people.map((p) => p.role)).toEqual(['guest', 'guest']);
  });

  it('has no section, and the report it would have had, when nobody has a title', () => {
    const without = buildSyncReport(take).json;
    for (const nameTags of [
      undefined,
      {},
      { hostName: 'Ana' },
      { hostName: 'Ana', hostTitle: '   ', slotTitles: new Map<number, string>() },
      { slotTitles: new Map([[7, 'Nobody listed']]) },
    ]) {
      const report = buildSyncReport({ ...take, nameTags });
      expect(report.json).toBe(without);
      expect('nameTags' in JSON.parse(report.json)).toBe(false);
    }
  });

  it('writes a name and a title cleaned of control characters and bidirectional marks', () => {
    const json = jsonOf({
      ...take,
      nameTags: {
        hostName: 'A\u202Ena\u0007',
        hostTitle: 'Chief\n\u2066Officer\u2069\u200F',
        slotTitles: new Map([[0, '\u0000Author\u061C\tof\u2028books']]),
      },
    });
    const people = json.nameTags?.people ?? [];
    expect(people[0]).toMatchObject({ name: 'A na', title: 'Chief Officer' });
    expect(people[1]).toMatchObject({ slot: 0, title: 'Author of books' });
  });

  it('leaves out a title of 61 units, a number and an object, and still builds the report', () => {
    const json = jsonOf({
      ...take,
      nameTags: {
        hostTitle: 'x'.repeat(61),
        slotTitles: new Map<number, unknown>([
          [0, 42],
          [1, { toString: () => 'Editor' }],
        ]) as ReadonlyMap<number, string>,
      },
    });
    expect('nameTags' in json).toBe(false);
    expect(json.recordingId).toBe('rec');
    const kept = jsonOf({
      ...take,
      nameTags: { hostTitle: 'x'.repeat(60), slotTitles: new Map<number, unknown>([[0, 42]]) as ReadonlyMap<number, string> },
    });
    expect(kept.nameTags?.people[0]?.title).toBe('x'.repeat(60));
    expect(kept.nameTags?.people[1]).not.toHaveProperty('title');
  });

  it('writes the report without the section when reading a title throws', () => {
    const slotTitles = new Map([[0, 'Author']]);
    slotTitles.get = () => {
      throw new Error('boom');
    };
    const input = { ...take, nameTags: { hostTitle: 'Founder', slotTitles } };
    const json = jsonOf(input);
    expect('nameTags' in json).toBe(false);
    expect(json.recordingId).toBe('rec');
    expect(json.files).toMatchObject({ host: 'host-ana_rec.mp4', guest: 'guest_rec.mp4' });

    const getter = {
      get hostTitle(): string {
        throw new Error('boom');
      },
    };
    expect('nameTags' in jsonOf({ ...take, nameTags: getter })).toBe(false);
  });
});

const GUEST = { peerId: 'p-guest', ordinal: 2, role: 'guest', displayName: 'Asha' };
const GUEST_2 = { peerId: 'p-guest-2', ordinal: 3, role: 'guest', displayName: 'Ben' };

function emit(type: string, payload: any) {
  for (const handler of signalHandlers[type] ?? []) handler(payload);
}

function lobbyStream() {
  const audio = { kind: 'audio', enabled: true, stop: vi.fn(), getSettings: () => ({ echoCancellation: false }) };
  return Object.assign(new EventTarget(), {
    getTracks: () => [],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [{ kind: 'video' }],
  }) as unknown as MediaStream;
}

let blobs: Blob[] = [];

const readBlob = (b: Blob) =>
  new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsText(b);
  });

/** A host in a room with one guest. */
async function hosting(peers = [GUEST]) {
  const { result } = renderHook(() => useRoom('abc-defg-hij'));
  await act(async () => {
    await result.current.join(lobbyStream(), 'Host Hana');
  });
  await act(async () => {
    emit('role-assigned', {
      type: 'role-assigned',
      role: 'host',
      peerId: 'p-host',
      ordinal: 1,
      peers,
      recording: false,
    });
  });
  return result;
}

/** A guest's presence as the Room relays it. */
const presence = (fromPeerId: string, title?: unknown) =>
  act(() =>
    emit('presence', {
      type: 'presence',
      micOn: true,
      camOn: true,
      screenSharing: false,
      from: 'guest',
      fromPeerId,
      ...(title === undefined ? {} : { title }),
    })
  );

/** Records a take, runs `during` in the middle of it, and returns the sync file as written. */
async function savedReport(result: { current: ReturnType<typeof useRoom> }, during: () => void = () => {}) {
  await act(async () => {
    await result.current.startRecording();
  });
  during();
  await act(async () => {
    await result.current.endRecording();
  });
  const json = blobs.find((b) => b.type === 'application/json');
  return JSON.parse(await readBlob(json as Blob)) as Json;
}

describe('useRoom: name tags in the written sync file', () => {
  beforeEach(() => {
    signalHandlers = {};
    blobs = [];
    second.on = false;
    chooseTitle('');
    globalThis.URL.createObjectURL = vi.fn().mockImplementation((b: Blob) => {
      blobs.push(b);
      return 'blob:mock-url';
    });
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.clearAllMocks();
  });

  it("writes the host's own name and title and a guest's title with their file", async () => {
    chooseTitle('Founder, Acme');
    const result = await hosting();
    await presence('p-guest', 'Author');
    const json = await savedReport(result);
    expect(json.nameTags?.people).toEqual([
      { role: 'host', name: 'Host Hana', title: 'Founder, Acme', files: ['host_rec-host-1.mp4'] },
      { role: 'guest', slot: 0, name: 'Asha', title: 'Author', files: ['guest_rec-host-1.mp4'] },
    ]);
  });

  it('has no section when nobody gave a title', async () => {
    const result = await hosting();
    await presence('p-guest');
    const json = await savedReport(result);
    expect('nameTags' in json).toBe(false);
  });

  it('keeps a guest title after that guest left', async () => {
    const result = await hosting();
    await presence('p-guest', 'Author');
    const json = await savedReport(result, () =>
      act(() => emit('peer-left', { type: 'peer-left', role: 'guest', reason: 'gone', peerId: 'p-guest' }))
    );
    expect(json.nameTags?.people[1]).toMatchObject({ role: 'guest', slot: 0, title: 'Author' });
  });

  it('drops a guest title when their next presence has none, or one that is not usable', async () => {
    for (const next of [undefined, '', '   ', 'x'.repeat(61), 7, {}]) {
      signalHandlers = {};
      blobs = [];
      const result = await hosting();
      await presence('p-guest', 'Author');
      await presence('p-guest', next);
      expect('nameTags' in (await savedReport(result))).toBe(false);
    }
  });

  it('forgets the oldest guest title once 64 others have been kept', async () => {
    const lost = await hosting();
    await presence('p-guest', 'Author');
    for (let i = 0; i < 64; i++) await presence(`other-${i}`, 'Guest');
    expect('nameTags' in (await savedReport(lost))).toBe(false);

    signalHandlers = {};
    blobs = [];
    const kept = await hosting();
    await presence('p-guest', 'Author');
    for (let i = 0; i < 63; i++) await presence(`other-${i}`, 'Guest');
    expect((await savedReport(kept)).nameTags?.people[1]).toMatchObject({ title: 'Author' });
  });

  it('does not count a title that is blank or too long against the 64 it keeps', async () => {
    const result = await hosting();
    await presence('p-guest', 'Author');
    for (let i = 0; i < 64; i++) await presence(`other-${i}`, i % 2 ? '   ' : 'x'.repeat(61));
    expect((await savedReport(result)).nameTags?.people[1]).toMatchObject({ title: 'Author' });
  });

  it('does not keep a title from a presence whose peer id is not text', async () => {
    const result = await hosting();
    await presence('p-guest', 'Author');
    for (let i = 0; i < 64; i++) await presence(i as unknown as string, 'Guest');
    expect((await savedReport(result)).nameTags?.people[1]).toMatchObject({ title: 'Author' });
  });

  it("writes each guest's title with that guest's own files", async () => {
    second.on = true;
    const result = await hosting([GUEST, GUEST_2]);
    await presence('p-guest', 'Author');
    await presence('p-guest-2', 'Editor');
    const json = await savedReport(result);
    expect(json.nameTags?.people).toEqual([
      { role: 'host', name: 'Host Hana', files: ['host_rec-host-1.mp4'] },
      { role: 'guest', slot: 0, name: 'Asha', title: 'Author', files: ['guest_rec-host-1.mp4'] },
      { role: 'guest', slot: 1, name: 'Ben', title: 'Editor', files: ['guest2_rec-host-1.mp4'] },
    ]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { encodeChunkHeader, CHUNK_TIMESLICE_MS } from '@openmeet/protocol';
import { recordingErrorMessage } from '@/hooks/useRoom';
import { buildSyncReport, fileVerdict } from '@/lib/sync-report';
import type { TakeJournal, TakeNotes } from '@/lib/take-journal';
import {
  bindHostGuestChannel,
  bindHostAudioChannel,
  bindHostScreenChannel,
  collectGuestReports,
  collectFileChecks,
  collectScreenSegments,
  endHostRecording,
  type RecordingHandles,
} from '@/hooks/recording-controller';

/**
 * Host-driven recording means ONE click starts every guest at once. Before
 * that, every guest's channel was bound to the single receiver opened up
 * front — so guests 2 and 3 wrote their own H.264 streams into guest 1's file
 * at their own offsets. Two-person rooms were fine; a three-person room
 * produced one unplayable MP4 and no error anywhere.
 */

type Written = { file: string; position: number; bytes: number };

function fakeDir(opened: string[], written: Written[]) {
  return {
    getFileHandle: async (name: string) => {
      opened.push(name);
      return {
        name,
        createWritable: async () => ({
          write: async (d: { position: number; data: ArrayBuffer }) => {
            written.push({ file: name, position: d.position, bytes: d.data.byteLength });
          },
          close: async () => {},
        }),
      };
    },
  } as unknown as NonNullable<RecordingHandles['dir']>;
}

/** A DataChannel stub that just captures the handler bindHostChannel installs. */
function fakeChannel(label = '') {
  const ch = {
    label,
    binaryType: '',
    readyState: 'open',
    onmessage: null as ((ev: MessageEvent) => void) | null,
    sent: [] as (string | ArrayBuffer)[],
    addEventListener: () => {},
    send(data: string | ArrayBuffer) {
      ch.sent.push(data);
    },
    async deliver(data: string | ArrayBuffer) {
      await (ch.onmessage as unknown as (ev: { data: unknown }) => Promise<void>)?.({ data });
    },
  };
  return ch as unknown as RTCDataChannel & {
    deliver(d: string | ArrayBuffer): Promise<void>;
    sent: (string | ArrayBuffer)[];
  };
}

async function sendChunk(ch: { deliver(d: string | ArrayBuffer): Promise<void> }, idx: number, offset: number, size: number) {
  await ch.deliver(encodeChunkHeader({ idx, offset, size, ts: 0 }));
  await ch.deliver(new Uint8Array(size).buffer);
}

/**
 * What startHostRecording leaves behind: slot 0's MP4 writer and receiver are
 * opened eagerly, before any guest exists.
 */
async function hostHandles(opened: string[], written: Written[], slot0: Written[]) {
  const { ChunkReceiver } = await import('@/lib/chunk-receiver');
  const h: RecordingHandles = {
    recordingId: 'rec',
    take: 1,
    dir: fakeDir(opened, written),
    channelRef: { current: null },
  };
  h.receiver = new ChunkReceiver({
    recordingId: 'rec',
    writer: {
      write: async (position: number, data: ArrayBuffer) => {
        slot0.push({ file: 'guest_rec.mp4', position, bytes: data.byteLength });
      },
      fileName: 'guest_rec.mp4',
    } as never,
    sendControl: () => {},
  });
  return h;
}

/** A TakeJournal whose parts are counted, so a test can tell a receiver really holds its journal file. */
function fakeJournal() {
  const notes: TakeNotes = {
    room: 'abc-defg-hij',
    recordingId: 'rec',
    take: 1,
    hostStartMs: 1_700_000_000_000,
    files: [],
    backups: [],
    markers: [],
  };
  const parts = new Map<string, { appends: number; commits: number }>();
  const file = (name: string) => {
    const counts = parts.get(name) ?? { appends: 0, commits: 0 };
    parts.set(name, counts);
    return {
      append: () => {
        counts.appends += 1;
      },
      commit: async () => {
        counts.commits += 1;
      },
      dead: false,
    };
  };
  const journal = {
    notes,
    note: (change: (n: TakeNotes) => void) => change(notes),
    file,
  } as unknown as TakeJournal;
  return { journal, parts };
}

describe('host ingest routes by source peer', () => {
  it('gives each guest its own MP4 instead of interleaving into one', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const slot0: Written[] = [];
    const h = await hostHandles(opened, written, slot0);

    const a = fakeChannel();
    const b = fakeChannel();
    await bindHostGuestChannel(a, h, 'peer-a');
    await bindHostGuestChannel(b, h, 'peer-b');

    await sendChunk(a, 0, 0, 100);
    await sendChunk(b, 0, 0, 250);

    // peer-a keeps the original filename; peer-b gets its own file.
    expect(opened).toEqual(['guest2_rec.mp4']);
    expect(slot0).toEqual([{ file: 'guest_rec.mp4', position: 0, bytes: 100 }]);
    expect(written).toEqual([{ file: 'guest2_rec.mp4', position: 0, bytes: 250 }]);
  });

  it('reuses one file per peer across a channel rebind', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);

    // Slots go by arrival order, so peer-a takes slot 0 and peer-b takes 1.
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    const first = fakeChannel();
    await bindHostGuestChannel(first, h, 'peer-b');
    for (let i = 0; i < 5; i++) await sendChunk(first, i, i * 10, 10);
    const second = fakeChannel();
    await bindHostGuestChannel(second, h, 'peer-b'); // reconnect
    await sendChunk(second, 5, 900, 10);

    expect(opened).toEqual(['guest2_rec.mp4']); // opened once, not twice
    // idx/offset continue on the SAME receiver, so a resumed stream doesn't
    // restart at zero and overwrite what's already on disk.
    expect(written).toHaveLength(6);
    expect(written.at(-1)).toEqual({ file: 'guest2_rec.mp4', position: 900, bytes: 10 });
  });

  it('separates the WAV masters per peer too', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h: RecordingHandles = { recordingId: 'rec', take: 1, dir: fakeDir(opened, written) };

    await bindHostAudioChannel(fakeChannel(), h, 'peer-a');
    await bindHostAudioChannel(fakeChannel(), h, 'peer-b');

    expect(opened).toEqual(['guest_rec.wav', 'guest2_rec.wav']);
    // The two-person path still populates the fields the sync report reads.
    expect(h.guestWavWriter?.fileName).toBe('guest_rec.wav');
    expect(h.wavReceiver).toBeDefined();
  });

  it('writes nothing when the host is not recording', async () => {
    const h: RecordingHandles = { recordingId: 'rec' }; // no dir => no recording
    const ch = fakeChannel();
    await bindHostGuestChannel(ch, h, 'peer-b');
    expect(ch.onmessage).toBeNull();
  });

  it("collectFileChecks returns one entry per open writer with that file's size", async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const slot0: Written[] = [];
    const h = await hostHandles(opened, written, slot0);

    const a = fakeChannel();
    const b = fakeChannel();
    const w = fakeChannel();

    await bindHostGuestChannel(a, h, 'peer-a');
    await bindHostGuestChannel(b, h, 'peer-b');
    await sendChunk(b, 0, 0, 250);

    await bindHostAudioChannel(w, h, 'peer-a');
    await sendChunk(w, 0, 0, 40);

    await new Promise((r) => setTimeout(r));

    const checks = await collectFileChecks(h);
    expect(checks.get('guest2_rec.mp4')?.bytes).toBe(250);
    expect(checks.get('guest_rec.wav')?.bytes).toBe(40);
    expect(checks.size).toBe(2);
  });

  it('reports a WAV whose header is sent twice by its length, not by the bytes written', async () => {
    const h = await hostHandles([], [], []);
    const w = fakeChannel();
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    await bindHostGuestChannel(fakeChannel(), h, 'peer-b');
    await bindHostAudioChannel(w, h, 'peer-b');
    await sendChunk(w, 0, 0, 44);
    await sendChunk(w, 1, 44, 100);
    await sendChunk(w, 2, 0, 44);
    await new Promise((r) => setTimeout(r));
    expect(h.guestReceivers!.get('peer-b:wav')!.receiver.bytesWritten).toBe(188);
    expect((await collectFileChecks(h)).get('guest2_rec.wav')?.bytes).toBe(144);
  });

  it('ignores an empty frame at a huge offset and reads the file as empty', async () => {
    const h = await hostHandles([], [], []);

    const b = fakeChannel();
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    await bindHostGuestChannel(b, h, 'peer-b');
    await sendChunk(b, 0, 1_000_000_000, 0);
    await new Promise((r) => setTimeout(r));

    const check = (await collectFileChecks(h)).get('guest2_rec.mp4');
    expect(check?.bytes).toBe(0);
    expect(fileVerdict(check, 'Bob')).toEqual({
      status: 'incomplete',
      text: 'Empty. Nothing arrived from Bob. If they were recording, ask them for the backup their browser kept; it is listed in the lobby on their device.',
    });
  });

  it("reports the sender's claim against the host's own digest, and no sender digest when unfinalized", async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const slot0: Written[] = [];
    const h = await hostHandles(opened, written, slot0);

    const a = fakeChannel();
    const b = fakeChannel();
    const w = fakeChannel();

    await bindHostGuestChannel(a, h, 'peer-a');
    await bindHostGuestChannel(b, h, 'peer-b');
    await bindHostAudioChannel(w, h, 'peer-b');
    await sendChunk(b, 0, 0, 250);
    await sendChunk(w, 0, 0, 40);

    await new Promise((r) => setTimeout(r));

    const own = await h.guestReceivers!.get('peer-b:mp4')!.receiver.digestHex();
    // A claim that cannot be the digest of what the host wrote: the written
    // digest must come from the host's own bytes, never from the sender.
    const claimed = 'F'.repeat(64);
    await b.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 250, sha256: claimed })
    );

    const checks = await collectFileChecks(h);
    expect(checks.get('guest2_rec.mp4')?.received).toEqual({
      finalized: true,
      abandoned: false,
      sha256Sent: claimed,
      sha256Written: own,
    });
    expect(checks.get('guest2_rec.wav')?.received).toEqual({
      finalized: false,
      abandoned: false,
      sha256Sent: undefined,
      sha256Written: await h.guestReceivers!.get('peer-b:wav')!.receiver.digestHex(),
    });
  });

  it('reports abandoned: true when stream-abandoned is delivered', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const slot0: Written[] = [];
    const h = await hostHandles(opened, written, slot0);

    const a = fakeChannel();
    const b = fakeChannel();

    await bindHostGuestChannel(a, h, 'peer-a');
    await bindHostGuestChannel(b, h, 'peer-b');
    await sendChunk(b, 0, 0, 250);

    await new Promise((r) => setTimeout(r));

    await b.deliver(JSON.stringify({ type: 'stream-abandoned', recordingId: 'rec', lastIdx: 0 }));

    const checks = await collectFileChecks(h);
    expect(checks.get('guest2_rec.mp4')?.received).toMatchObject({ finalized: false, abandoned: true });
    expect(checks.get('guest2_rec.mp4')?.received?.sha256Sent).toBeUndefined();

    // A sender can still finalize after giving up: each fact is carried on its own.
    await b.deliver(JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 250 }));
    expect((await collectFileChecks(h)).get('guest2_rec.mp4')?.received).toMatchObject({
      finalized: true,
      abandoned: true,
    });
  });

  it("reports finalized with no sender digest when the sender's digest is missing or too long", async () => {
    const h = await hostHandles([], [], []);

    const b = fakeChannel();
    const c = fakeChannel();

    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    await bindHostGuestChannel(b, h, 'peer-b');
    await bindHostGuestChannel(c, h, 'peer-c');

    // Neither message leaves a digest; both still say the sender finished.
    await b.deliver(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'rec',
        totalBytes: 250,
        sha256: 'x'.repeat(65),
      })
    );
    await c.deliver(JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 250 }));

    const checks = await collectFileChecks(h);
    expect(checks.get('guest2_rec.mp4')?.received).toMatchObject({ finalized: true });
    expect(checks.get('guest2_rec.mp4')?.received?.sha256Sent).toBeUndefined();
    expect(checks.get('guest3_rec.mp4')?.received).toMatchObject({ finalized: true });
    expect(checks.get('guest3_rec.mp4')?.received?.sha256Sent).toBeUndefined();
  });

  it("reports slot 0's WAV master with the sender's facts", async () => {
    const h = await hostHandles([], [], []);

    const wa = fakeChannel();

    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    await bindHostAudioChannel(wa, h, 'peer-a');

    await wa.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 40, sha256: 'abc' })
    );

    const checks = await collectFileChecks(h);
    expect(checks.get('guest_rec.wav')?.received).toMatchObject({ finalized: true, sha256Sent: 'abc' });
  });

  it('reports a guest file that received no bytes with the facts its receiver has', async () => {
    const h = await hostHandles([], [], []);

    const b = fakeChannel();
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    await bindHostGuestChannel(b, h, 'peer-b');

    await new Promise((r) => setTimeout(r));

    const checks = await collectFileChecks(h);
    expect(checks.get('guest2_rec.mp4')).toMatchObject({
      bytes: 0,
      received: {
        finalized: false,
        abandoned: false,
        sha256Written: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });

    // A guest with nothing to send still finalizes, with an empty digest.
    await b.deliver(JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 0, sha256: '' }));
    expect((await collectFileChecks(h)).get('guest2_rec.mp4')).toMatchObject({
      bytes: 0,
      received: { finalized: true, sha256Sent: '' },
    });
  });

  it('preserves empty string sender digest as sha256Sent: "" when guest sends empty digest', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const slot0: Written[] = [];
    const h = await hostHandles(opened, written, slot0);

    const a = fakeChannel();
    const b = fakeChannel();

    await bindHostGuestChannel(a, h, 'peer-a');
    await bindHostGuestChannel(b, h, 'peer-b');
    await sendChunk(b, 0, 0, 250);

    await new Promise((r) => setTimeout(r));

    await b.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 250, sha256: '' })
    );

    const checks = await collectFileChecks(h);
    expect(checks.get('guest2_rec.mp4')?.received?.sha256Sent).toBe('');
  });

  it('notes a new guest file and commits its bytes into the journal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const opened: string[] = [];
      const written: Written[] = [];
      const h = await hostHandles(opened, written, []);
      const { journal, parts } = fakeJournal();
      h.journal = journal;

      await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
      const b = fakeChannel();
      await bindHostGuestChannel(b, h, 'peer-b');

      expect(journal.notes.files).toEqual([
        { file: 'guest2_rec.mp4', kind: 'camera', key: 'peer-b', slot: 1 },
      ]);

      await sendChunk(b, 0, 0, 250);
      await new Promise((r) => setTimeout(r, 0));
      vi.setSystemTime(Date.now() + CHUNK_TIMESLICE_MS);
      await sendChunk(b, 1, 250, 250);
      await new Promise((r) => setTimeout(r, 0));

      expect(parts.get('guest2_rec.mp4')).toEqual({ appends: 2, commits: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives slot 0's note the channel key and the name at bind time", async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);
    const { journal } = fakeJournal();
    h.journal = journal;
    h.guestWriter = { fileName: 'guest_rec.mp4' } as never;
    journal.notes.files.push({ file: 'guest_rec.mp4', kind: 'camera', slot: 0 });

    await bindHostGuestChannel(fakeChannel('recording#k1'), h, 'peer-a', undefined, 'Bob');
    expect(journal.notes.files[0]).toEqual({
      file: 'guest_rec.mp4',
      kind: 'camera',
      slot: 0,
      key: 'k1',
      who: 'Bob',
    });

    // A rebind of the same slot carries the name the room knows now.
    await bindHostGuestChannel(fakeChannel('recording#k1'), h, 'peer-a', undefined, 'B'.repeat(300));
    expect(journal.notes.files[0]?.who).toBe('B'.repeat(200));

    // A second guest's new file gets its own key, also capped.
    await bindHostGuestChannel(fakeChannel('recording#k2'), h, 'peer-b', undefined, 'C'.repeat(300));
    expect(journal.notes.files[1]).toMatchObject({ file: 'guest2_rec.mp4', key: 'k2', who: 'C'.repeat(200) });

    // The key is a channel-label key, so a key too long to be one never reaches a note.
    await bindHostGuestChannel(fakeChannel(`recording#${'k'.repeat(300)}`), h, 'peer-c', undefined, 'Carol');
    expect(journal.notes.files).toHaveLength(2);
    expect(opened).toEqual(['guest2_rec.mp4']);
  });

  it('caps journal notes at 64 files and keeps the first 64 notes', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);
    const { journal } = fakeJournal();
    h.journal = journal;
    for (let i = 0; i < 64; i++) {
      journal.notes.files.push({ file: `f${i}.mp4`, kind: 'camera', slot: i });
    }

    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    await bindHostGuestChannel(fakeChannel('recording#k-extra'), h, 'peer-extra');

    expect(journal.notes.files).toHaveLength(64);
    expect(journal.notes.files.some((f) => f.key === 'k-extra')).toBe(false);
  });
});

/**
 * The DO mints a fresh peerId per socket, so a full WS reconnect
 * changes the peerId a guest's channel arrives from. Slots/receivers used to be
 * keyed on that peerId, so a reconnect looked like a brand-new guest — new
 * slot, new file, new (empty) receiver — even though the real file and its
 * lastIdx were still sitting there waiting to be resumed. A label carrying a
 * stable key (`recording#<recordingId>`) fixes that: the key, not the peerId,
 * picks the slot.
 */
describe('host ingest keys guest slots by the channel-label key when present, not the volatile peerId', () => {
  it('the same key from two different peer ids reuses the same receiver, slot 0, and file; resume answers with the real lastIdx', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const dir = fakeDir(opened, written);
    const { ChunkReceiver } = await import('@/lib/chunk-receiver');
    // Mirrors what startHostRecording leaves behind for slot 0: a receiver whose
    // sendControl actually follows the live channel via channelRef, unlike the
    // hostHandles() helper above (which is a no-op stub not needed elsewhere).
    const channelRef: { current: RTCDataChannel | null } = { current: null };
    const receiver = new ChunkReceiver({
      recordingId: 'rec',
      writer: {
        write: async (position: number, data: ArrayBuffer) => {
          written.push({ file: 'guest_rec.mp4', position, bytes: data.byteLength });
        },
        fileName: 'guest_rec.mp4',
      } as never,
      sendControl: (json) => {
        const c = channelRef.current;
        if (c && c.readyState === 'open') c.send(json);
      },
    });
    const h: RecordingHandles = { recordingId: 'rec', take: 1, dir, channelRef, receiver };

    const a = fakeChannel('recording#R1');
    await bindHostGuestChannel(a, h, 'peer-a');
    // The first attach announces too: the guest learns where the file ends
    // without racing a query against the host's own open.
    expect(a.sent).toEqual([
      JSON.stringify({ type: 'resume_offset', recordingId: 'rec', lastByte: 0, lastIdx: -1 }),
    ]);
    await sendChunk(a, 0, 0, 100);

    // Reconnect: a NEW peerId, but the SAME label key.
    const b = fakeChannel('recording#R1');
    await bindHostGuestChannel(b, h, 'peer-b');

    expect(opened).toEqual([]); // slot 0's file was already open; no second file
    expect(h.receiver).toBe(receiver); // same receiver instance, not a fresh one
    expect(b.sent).toEqual([
      JSON.stringify({ type: 'resume_offset', recordingId: 'rec', lastByte: 100, lastIdx: 0 }),
    ]);

    b.sent.length = 0;
    await b.deliver(JSON.stringify({ type: 'resume_query', recordingId: 'rec' }));
    expect(b.sent).toEqual([
      JSON.stringify({ type: 'resume_offset', recordingId: 'rec', lastByte: 100, lastIdx: 0 }),
    ]);
  });

  it('different keys get different slots, even across different peer ids', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const slot0: Written[] = [];
    const h = await hostHandles(opened, written, slot0);

    await bindHostGuestChannel(fakeChannel('recording#R1'), h, 'peer-a');
    await bindHostGuestChannel(fakeChannel('recording#R2'), h, 'peer-b');

    expect(opened).toEqual(['guest2_rec.mp4']); // R2 is a new key => its own slot/file
  });

  it("cannot select another guest's row with a channel-label key it guessed", async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const slot0: Written[] = [];
    const h = await hostHandles(opened, written, slot0);

    // peer-a's channel carries the key its recorder minted. peer-b guesses
    // peer-a's peerId as a key, not the minted one, so it gets its own row:
    // the signals it sends land there, not on peer-a's file.
    const a = fakeChannel('recording#R1');
    const b = fakeChannel('recording#peer-a');
    await bindHostGuestChannel(a, h, 'peer-a');
    await sendChunk(a, 0, 0, 100);
    await bindHostGuestChannel(b, h, 'peer-b');
    await new Promise((r) => setTimeout(r));
    await b.deliver(JSON.stringify({ type: 'stream-abandoned', recordingId: 'rec', lastIdx: 0 }));

    expect(opened).toEqual(['guest2_rec.mp4']);
    expect(h.receiver?.isAbandoned).toBe(false);
    const checks = await collectFileChecks(h);
    expect(checks.get('guest2_rec.mp4')?.received?.abandoned).toBe(true);
  });

  it("each guest's rate lands on that guest's entry, not a neighbour's", async () => {
    const h = await hostHandles([], [], []);
    const a = fakeChannel();
    const b = fakeChannel();
    const c = fakeChannel();
    await bindHostGuestChannel(a, h, 'peer-a');
    await bindHostGuestChannel(b, h, 'peer-b');
    await bindHostGuestChannel(c, h, 'peer-c');
    await a.deliver(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'rec',
        totalBytes: 0,
        sha256: 'a',
        frameRate: 25,
      })
    );
    await b.deliver(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'rec',
        totalBytes: 0,
        sha256: 'b',
        frameRate: 50,
      })
    );
    expect((await collectGuestReports(h)).map((g) => [g.slot, g.trackFps])).toEqual([
      [0, 25],
      [1, 50],
      [2, null],
    ]);
  });
});

/**
 * useRoom.ts keeps a `audioChannelsRef` map of a guest's WAV channel,
 * keyed by socket peerId, and binds every entry it holds when Record is
 * clicked. It used not to be cleared between takes. A guest mints a fresh
 * recordingId (the channel-label key) per take, so a dead take-1 channel left
 * in that map claims slot 0 in take 2 before the real take-2 channel arrives
 * — opening a WAV nobody writes, and pushing the guest's real files to slot 1.
 *
 * This models useRoom's exact sequence (map.set on channel arrival, bind-loop
 * at Record time, clear on newTake) with a plain Map standing in for the
 * private `audioChannelsRef`, using the real bindHostAudioChannel/
 * bindHostGuestChannel/guestSlot from recording-controller.ts. Driving the
 * actual useRoom hook end-to-end would additionally require mocking
 * SignalClient, PeerConnection, MediaManager, host-token, getTurnCred/getRoom
 * and MediaRecorder/PCM capture — none of which this bug touches.
 */
describe('a stale take-1 audio channel must not claim slot 0 in take 2', () => {
  async function hostHandlesFor(recordingId: string, opened: string[], written: Written[]) {
    const { ChunkReceiver } = await import('@/lib/chunk-receiver');
    const h: RecordingHandles = {
      recordingId,
      take: 1,
      dir: fakeDir(opened, written),
      channelRef: { current: null },
    };
    h.receiver = new ChunkReceiver({
      recordingId,
      writer: {
        write: async (position: number, data: ArrayBuffer) => {
          written.push({ file: `guest_${recordingId}.mp4`, position, bytes: data.byteLength });
        },
        fileName: `guest_${recordingId}.mp4`,
      } as never,
      sendControl: () => {},
    });
    return h;
  }

  it('slot 0 goes to the real take-2 guest; nothing is ever opened for the dead take-1 key', async () => {
    // Mirrors useRoom.ts's private audioChannelsRef: Map<peerId, RTCDataChannel>.
    const audioChannelsRef = new Map<string, RTCDataChannel>();

    // Take 1: the guest's WAV channel arrives and is stored (onDataChannel).
    audioChannelsRef.set('peer-a', fakeChannel('recording-audio#R1'));

    // newTake(): the fix clears audioChannelsRef here.
    audioChannelsRef.clear();

    // Take 2 starts with fresh handles (a new startHostRecording call).
    const opened: string[] = [];
    const written: Written[] = [];
    const h2 = await hostHandlesFor('rec2', opened, written);

    // Record is clicked for take 2 before the guest's new channels arrive —
    // only whatever audioChannelsRef still holds gets bound here.
    for (const [pid, ac] of audioChannelsRef) await bindHostAudioChannel(ac, h2, pid);

    // The guest's real take-2 channels then arrive via onDataChannel.
    const videoR2 = fakeChannel('recording#R2');
    const audioR2 = fakeChannel('recording-audio#R2');
    audioChannelsRef.set('peer-a', audioR2);
    await bindHostGuestChannel(videoR2, h2, 'peer-a');
    await bindHostAudioChannel(audioR2, h2, 'peer-a');
    await sendChunk(videoR2, 0, 0, 50);

    // Both files land in slot 0: the mp4 (pre-opened by startHostRecording)
    // gets the real bytes, and the only lazily-opened file is the take-2 wav.
    expect(opened).toEqual(['guest_rec2.wav']);
    expect(written).toEqual([{ file: 'guest_rec2.mp4', position: 0, bytes: 50 }]);
    // No slot was ever created for the dead take-1 key.
    expect(h2.guestSlots?.has('R1')).toBe(false);
    expect(h2.guestSlots?.get('R2')).toBe(0);
  });
});

/**
 * A guest who leaves mid-take is already gone from the room when End & save
 * reads the names, which is exactly the case where a file is incomplete and
 * the host needs to know whose it is. Each slot keeps the name its channel was
 * bound with; a name still in the room at the end wins over it, and a slot
 * that was never bound with one falls back as before.
 */
describe("a guest who left keeps the name their slot was bound with", () => {
  const nobodyLeft = () => undefined;

  it('names both guests on their camera and WAV files when one has left', async () => {
    const h = await hostHandles([], [], []);
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a', undefined, 'Ann');
    await bindHostGuestChannel(fakeChannel(), h, 'peer-b', undefined, 'Bo');
    await bindHostAudioChannel(fakeChannel(), h, 'peer-b', undefined, 'Bo');

    const reports = await collectGuestReports(h, (id) => (id === 'peer-a' ? 'Ann' : undefined));
    expect(reports.map((g) => [g.slot, g.name, g.wavFile])).toEqual([
      [0, 'Ann', undefined],
      [1, 'Bo', 'guest2_rec.wav'],
    ]);

    const report = buildSyncReport({
      recordingId: 'rec',
      hostFile: 'host_rec.mp4',
      hostStartMs: 0,
      guests: reports,
      checks: await collectFileChecks(h),
    });
    expect(report.data.fileList.find((f) => f.name === 'guest2_rec.mp4')?.participant).toBe('Bo');
    expect(report.data.fileList.find((f) => f.name === 'guest2_rec.wav')?.participant).toBe('Bo');
    expect(report.data.fileList.find((f) => f.name === 'guest2_rec.wav')?.verdict?.text).toContain('Bo');
  });

  it('prefers the name a guest is in the room with now over the stored one', async () => {
    const h = await hostHandles([], [], []);
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a', undefined, 'Bo');

    const reports = await collectGuestReports(h, () => 'Bobby');
    expect(reports[0]?.name).toBe('Bobby');
  });

  it('updates the stored name on a later bind, and keeps the last usable one', async () => {
    const h = await hostHandles([], [], []);
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a', undefined, 'Ann');
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a', undefined, 'Anna');
    // Nothing a reader could use is not a name: it must not erase the last one.
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a', undefined, '\n\n');

    const reports = await collectGuestReports(h, nobodyLeft);
    expect(reports[0]?.name).toBe('Anna');
  });

  it('updates the stored name when an audio channel is bound with a name', async () => {
    const h = await hostHandles([], [], []);
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    await bindHostAudioChannel(fakeChannel(), h, 'peer-a', undefined, 'Ann');

    const reports = await collectGuestReports(h, nobodyLeft);
    expect(reports[0]?.name).toBe('Ann');
  });

  it('sanitises the stored name the way a call copy name is sanitised', async () => {
    const h = await hostHandles([], [], []);
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a', undefined, 'Bo\nEvil');

    const reports = await collectGuestReports(h, nobodyLeft);
    expect(reports[0]?.name).toBe('Bo Evil');
  });

  it('names a screen segment whose guest sharer has left', async () => {
    const h = await hostHandles([], [], []);
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a', undefined, 'Ann');
    await bindHostScreenChannel(fakeChannel('recording-screen#R1'), h, undefined, 'peer-a');

    expect(collectScreenSegments(h, nobodyLeft).map((s) => s.sharer)).toEqual(['Ann']);
  });

  it('names a guest who left in the progress the host sees while the tail arrives', async () => {
    const h = await hostHandles([], [], []);
    const a = fakeChannel();
    const b = fakeChannel();
    await bindHostGuestChannel(a, h, 'peer-a', undefined, 'Ann');
    await bindHostGuestChannel(b, h, 'peer-b', undefined, 'Bo');
    const finalized = (idx: number) =>
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 0, sha256: `d${idx}` });
    await a.deliver(finalized(0));
    await b.deliver(finalized(1));

    const seen: string[][] = [];
    await endHostRecording(h, {
      onProgress: (pending) => seen.push(pending),
      getPeerName: () => undefined,
    });

    expect(seen[0]?.slice().sort()).toEqual(['Ann', 'Bo']);
  });
});

/**
 * The host opens a guest's WAV the moment the guest's audio channel arrives,
 * before any byte. When nothing follows, the 0-byte file stays in the folder,
 * so it has to be reported like every other file: a line, a size, a verdict
 * and a place in the count. "No WAV master" is then left for a guest whose
 * browser never opened one at all.
 */
describe('a guest WAV that received nothing is still reported', () => {
  it('lists it with an empty verdict and a verification entry, and drops the missing-master warning', async () => {
    const h = await hostHandles([], [], []);
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a', undefined, 'Ann');
    await bindHostAudioChannel(fakeChannel(), h, 'peer-a', undefined, 'Ann');

    const reports = await collectGuestReports(h, () => 'Ann');
    const report = buildSyncReport({
      recordingId: 'rec',
      hostFile: 'host_rec.mp4',
      hostStartMs: 0,
      guests: reports,
      checks: await collectFileChecks(h),
    });

    expect(reports[0]?.wavFile).toBe('guest_rec.wav');
    // There is a WAV master (the file), it just holds nothing.
    expect(reports[0]?.noWav).toBe(false);
    expect(report.data.fileList.find((f) => f.name === 'guest_rec.wav')).toMatchObject({
      kind: 'audio',
      bytes: 0,
      verdict: { status: 'incomplete', text: expect.stringContaining('Empty. Nothing arrived from Ann') },
    });
    type Verification = { file: string; bytes: number | null; status?: string };
    const verification = (JSON.parse(report.json) as { verification: Verification[] }).verification;
    expect(verification).toContainEqual(
      expect.objectContaining({ file: 'guest_rec.wav', bytes: 0, status: 'incomplete' })
    );
    expect(report.data.warnings.some((w) => w.includes('no WAV master'))).toBe(false);
  });

  it('still warns "no WAV master" for a guest with no WAV writer at all', async () => {
    const h = await hostHandles([], [], []);
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a', undefined, 'Ann');

    const reports = await collectGuestReports(h, () => 'Ann');
    const report = buildSyncReport({
      recordingId: 'rec',
      hostStartMs: 0,
      guests: reports,
      checks: await collectFileChecks(h),
    });

    expect(reports[0]?.wavFile).toBeUndefined();
    expect(reports[0]?.noWav).toBe(true);
    expect(report.data.warnings).toContain('no WAV master for Ann');
  });
});

/**
 * A guest picks the key in `recording#<key>`, and every new key becomes a new
 * slot, a new file in the host's folder and a new receiver, so a take opens at
 * most MAX_GUEST_SLOTS guest slots and one connection may introduce at most
 * MAX_GUEST_SLOTS_PER_PEER keys; a key that already has a slot always binds,
 * so a reconnect keeps its file.
 */
describe('a guest cannot make the host open files without end', () => {
  const REFUSAL_MESSAGE =
    'A guest opened more recordings than one take allows. The extra ones were not saved; their own backup has them.';

  function errorLog() {
    const errors: unknown[] = [];
    return {
      errors,
      onError: (e: unknown) => {
        errors.push(e);
      },
    };
  }

  it('refuses a third key from one connection: no file, no receiver, one report', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);
    const { errors, onError } = errorLog();

    const first = fakeChannel('recording#k1');
    const second = fakeChannel('recording#k2');
    const third = fakeChannel('recording#k3');
    await bindHostGuestChannel(first, h, 'peer-a', onError);
    await bindHostGuestChannel(second, h, 'peer-a', onError);
    await bindHostGuestChannel(third, h, 'peer-a', onError);

    // The first key claimed slot 0's eager file; only the second opened one.
    expect(opened).toEqual(['guest2_rec.mp4']);
    expect(h.guestReceivers?.has('k3:mp4')).toBe(false);
    expect(third.onmessage).toBeNull();
    expect(errors.map((e) => (e as Error).message)).toEqual([REFUSAL_MESSAGE]);
  });

  it('keeps refusing later keys from that connection without reporting again', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);
    const { errors, onError } = errorLog();

    await bindHostGuestChannel(fakeChannel('recording#k1'), h, 'peer-a', onError);
    await bindHostGuestChannel(fakeChannel('recording#k2'), h, 'peer-a', onError);
    await bindHostGuestChannel(fakeChannel('recording#k3'), h, 'peer-a', onError);
    const fourth = fakeChannel('recording#k4');
    await bindHostGuestChannel(fourth, h, 'peer-a', onError);

    expect(opened).toEqual(['guest2_rec.mp4']);
    expect(h.guestReceivers?.has('k4:mp4')).toBe(false);
    expect(fourth.onmessage).toBeNull();
    expect(errors.map((e) => (e as Error).message)).toEqual([REFUSAL_MESSAGE]);
    // A refused key is not remembered in either map.
    expect(h.guestSlotOwners?.size).toBe(2);
    expect(h.guestSlots?.size).toBe(2);
  });

  it('shows the refusal as the plain statement it is, not as a recording failure', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);
    const { errors, onError } = errorLog();

    await bindHostGuestChannel(fakeChannel('recording#k1'), h, 'peer-a', onError);
    await bindHostGuestChannel(fakeChannel('recording#k2'), h, 'peer-a', onError);
    await bindHostGuestChannel(fakeChannel('recording#k3'), h, 'peer-a', onError);

    expect(recordingErrorMessage(errors[0])).toBe(REFUSAL_MESSAGE);
  });

  it('opens one file per name when several channels of one key arrive together', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);
    // The first key takes slot 0, whose MP4 is opened eagerly; the burst below
    // takes a slot above 0, so every file it opens is visible here.
    await bindHostGuestChannel(fakeChannel('recording#k0'), h, 'peer-a');

    const camera = () => fakeChannel('recording#k1');
    const audio = () => fakeChannel('recording-audio#k1');
    await Promise.all([
      bindHostGuestChannel(camera(), h, 'peer-b'),
      bindHostGuestChannel(camera(), h, 'peer-b'),
      bindHostGuestChannel(camera(), h, 'peer-b'),
      bindHostAudioChannel(audio(), h, 'peer-b'),
      bindHostAudioChannel(audio(), h, 'peer-b'),
      bindHostAudioChannel(audio(), h, 'peer-b'),
    ]);

    expect(opened).toEqual(['guest2_rec.mp4', 'guest2_rec.wav']);
    expect(h.extraWriters).toHaveLength(2);
  });

  it("one refused connection does not refuse another connection's first key", async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);
    const { errors, onError } = errorLog();

    await bindHostGuestChannel(fakeChannel('recording#k1'), h, 'peer-a', onError);
    await bindHostGuestChannel(fakeChannel('recording#k2'), h, 'peer-a', onError);
    await bindHostGuestChannel(fakeChannel('recording#k3'), h, 'peer-a', onError);
    const b = fakeChannel('recording#b1');
    await bindHostGuestChannel(b, h, 'peer-b', onError);
    await sendChunk(b, 0, 0, 30);

    expect(opened).toEqual(['guest2_rec.mp4', 'guest3_rec.mp4']);
    expect(written).toEqual([{ file: 'guest3_rec.mp4', position: 0, bytes: 30 }]);
    expect(errors.map((e) => (e as Error).message)).toEqual([REFUSAL_MESSAGE]);
  });

  it('refuses the ninth key of a take, whoever opens it', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);
    const { errors, onError } = errorLog();

    // Five connections, two keys each, then one more: the take has eight slots.
    for (let p = 1; p <= 4; p++) {
      for (let k = 1; k <= 2; k++) {
        await bindHostGuestChannel(fakeChannel(`recording#p${p}k${k}`), h, `peer-${p}`, onError);
      }
    }
    const ninth = fakeChannel('recording#p5k1');
    await bindHostGuestChannel(ninth, h, 'peer-5', onError);

    expect(opened).toEqual([
      'guest2_rec.mp4',
      'guest3_rec.mp4',
      'guest4_rec.mp4',
      'guest5_rec.mp4',
      'guest6_rec.mp4',
      'guest7_rec.mp4',
      'guest8_rec.mp4',
    ]);
    expect(h.guestReceivers?.has('p5k1:mp4')).toBe(false);
    expect(ninth.onmessage).toBeNull();
    expect(errors.map((e) => (e as Error).message)).toEqual([REFUSAL_MESSAGE]);
  });

  it('keeps a key bindable from a new connection once the take is full', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const slot0: Written[] = [];
    const h = await hostHandles(opened, written, slot0);
    const { errors, onError } = errorLog();

    for (let p = 1; p <= 4; p++) {
      for (let k = 1; k <= 2; k++) {
        await bindHostGuestChannel(fakeChannel(`recording#p${p}k${k}`), h, `peer-${p}`, onError);
      }
    }
    await bindHostGuestChannel(fakeChannel('recording#p5k1'), h, 'peer-5', onError);
    expect(errors.map((e) => (e as Error).message)).toEqual([REFUSAL_MESSAGE]);

    // peer-1's tab reloaded: a new peer id, but the same key, so the same file.
    const reconnected = fakeChannel('recording#p1k1');
    await bindHostGuestChannel(reconnected, h, 'peer-6', onError);
    await sendChunk(reconnected, 0, 0, 10);

    expect(errors.map((e) => (e as Error).message)).toEqual([REFUSAL_MESSAGE]);
    expect(opened).toHaveLength(7);
    expect(slot0).toEqual([{ file: 'guest_rec.mp4', position: 0, bytes: 10 }]);
  });

  it('bounds the audio-master channel by the same keys, and its slot is shared with the camera', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);
    const { errors, onError } = errorLog();

    // One key's camera and audio are one key, both on slot 0.
    await bindHostGuestChannel(fakeChannel('recording#k1'), h, 'peer-a', onError);
    await bindHostAudioChannel(fakeChannel('recording-audio#k1'), h, 'peer-a', onError);
    // A second key's audio must not count as a third key.
    await bindHostGuestChannel(fakeChannel('recording#k2'), h, 'peer-a', onError);
    await bindHostAudioChannel(fakeChannel('recording-audio#k2'), h, 'peer-a', onError);
    // A third key's audio is refused like its camera would be.
    await bindHostAudioChannel(fakeChannel('recording-audio#k3'), h, 'peer-a', onError);

    expect(opened).toEqual(['guest_rec.wav', 'guest2_rec.mp4', 'guest2_rec.wav']);
    expect(h.guestReceivers?.has('k3:wav')).toBe(false);
    expect(errors.map((e) => (e as Error).message)).toEqual([REFUSAL_MESSAGE]);
  });
});

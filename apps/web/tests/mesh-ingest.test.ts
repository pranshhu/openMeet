import { describe, it, expect, vi } from 'vitest';
import { encodeChunkHeader, CHUNK_TIMESLICE_MS } from '@openmeet/protocol';
import { recordingErrorMessage } from '@/hooks/useRoom';
import { buildSyncReport, fileVerdict } from '@/lib/sync-report';
import { MAX_OFFSET_JUMP_BYTES } from '@/lib/chunk-receiver';
import { StreamingSha256 } from '@/lib/sha256';
import type { TakeJournal, TakeNotes } from '@/lib/take-journal';
import {
  bindHostGuestChannel,
  bindHostAudioChannel,
  bindHostScreenChannel,
  collectGuestReports,
  collectFileChecks,
  collectScreenSegments,
  endHostRecording,
  resumeHostRecording,
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

/**
 * `existing` is what the folder already holds, for the segment probe a resumed
 * take makes: a handle without `create` resolves only for those names, the way
 * the real File System Access API rejects a name that is not there. `probes`
 * records those lookups so a test can tell a probe from an open.
 */
function fakeDir(
  opened: string[],
  written: Written[],
  closed: string[] = [],
  existing: string[] = [],
  probes: string[] = []
) {
  const holds = new Set(existing);
  return {
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      if (!opts?.create) {
        probes.push(name);
        if (!holds.has(name)) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        return { name, createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
      }
      opened.push(name);
      holds.add(name);
      return {
        name,
        createWritable: async () => ({
          write: async (d: { position: number; data: ArrayBuffer | Blob }) => {
            written.push({
              file: name,
              position: d.position,
              bytes: d.data instanceof Blob ? d.data.size : d.data.byteLength,
            });
          },
          close: async () => {
            closed.push(name);
          },
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
 * A companion's own capture: no tracks, so a resume opens no host file. The
 * guest files are what these tests are about.
 */
function emptyFakeStream(): MediaStream {
  return {
    getTracks: () => [],
    getVideoTracks: () => [],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
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

type ResumeNote = {
  file: string;
  kind: 'camera' | 'wav' | 'screen';
  key?: string;
  slot?: number;
  segment?: number;
  who?: string;
  guestStartHostMs?: number | null;
  rttMs?: number | null;
  sha256State?: { nextIdx: number; words: number[]; remainder: number[]; length: number };
};
type JournalPosition = { nextIdx: number; end: number };

/**
 * A journal whose parts are already on disk from the crashed session: replay
 * hands the writer one Blob per part, and file(name).position() reports the
 * index and byte extent those parts prove.
 */
function resumeJournal(
  files: ResumeNote[],
  positions: Record<string, JournalPosition> = {},
  parts: Record<string, { offset: number; size: number }[]> = {},
  journalDead = false
) {
  const replayed: string[] = [];
  const notes: TakeNotes = {
    room: 'abc-defg-hij',
    recordingId: 'rec',
    take: 1,
    hostStartMs: 1_700_000_000_000,
    files,
    backups: [],
    markers: [],
  };
  const journal = {
    notes,
    note: (change: (n: TakeNotes) => void) => change(notes),
    file: (name: string) => ({
      append: () => {},
      commit: async () => {},
      position: async () => positions[name] ?? null,
      parts: async () => parts[name] ?? [],
      dead: journalDead,
    }),
    replay: async (name: string, into: { write(position: number, data: Blob): Promise<void> }) => {
      replayed.push(name);
      let end = 0;
      for (const part of parts[name] ?? []) {
        try {
          await into.write(part.offset, new Blob([new Uint8Array(part.size)]));
        } catch {
          break; // a real journal's replay never rejects
        }
        end = Math.max(end, part.offset + part.size);
      }
      return end;
    },
  } as unknown as TakeJournal;
  return { journal, replayed };
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

  it('carries the written digest in the guest report of a live take', async () => {
    const h = await hostHandles([], [], []);
    const a = fakeChannel();
    const b = fakeChannel();
    await bindHostGuestChannel(a, h, 'peer-a');
    await bindHostGuestChannel(b, h, 'peer-b');
    await sendChunk(b, 0, 0, 250);
    await new Promise((r) => setTimeout(r));

    // Slot 0 received nothing, so its digest is the empty input's; slot 1's is
    // the digest of the 250 zero bytes it took.
    const reports = await collectGuestReports(h);
    expect(reports.find((g) => g.slot === 0)?.sha256Written).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(reports.find((g) => g.slot === 1)?.sha256Written).toBe(
      '1a5ce2eb33e4dcd8bf09a57d740649e2aec359dc2c0fd952ac0d19d4a63d0c42'
    );
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

  it('writes a guest camera note even when the journal already holds 64', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const h = await hostHandles(opened, written, []);
    const { journal } = fakeJournal();
    h.journal = journal;
    for (let i = 0; i < 64; i++) {
      journal.notes.files.push({ file: `f${i}.mp4`, kind: 'screen', segment: i + 1 });
    }

    // A guest's camera file is bounded by the take's slots, not by a count
    // another guest's screen shares can spend.
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    await bindHostGuestChannel(fakeChannel('recording#k-extra'), h, 'peer-extra');

    expect(journal.notes.files).toHaveLength(65);
    expect(journal.notes.files.some((f) => f.key === 'k-extra')).toBe(true);
  });

  it('tells the host when the crash copy of a later guest file stops being kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = await hostHandles([], [], []);
      // Browser storage stops taking parts: every file reads dead once a commit ran.
      const { journal } = fakeJournal();
      let dead = false;
      (journal as unknown as { file: unknown }).file = () => ({
        append: () => {},
        commit: async () => {
          dead = true;
        },
        get dead() {
          return dead;
        },
      });
      h.journal = journal;
      const warns: string[] = [];
      h.onWarn = (m) => warns.push(m);

      await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
      const camera = fakeChannel();
      const audio = fakeChannel();
      await bindHostGuestChannel(camera, h, 'peer-b');
      await bindHostAudioChannel(audio, h, 'peer-b');
      for (const ch of [camera, audio]) await sendChunk(ch, 0, 0, 100);
      await new Promise((r) => setTimeout(r, 0));
      vi.setSystemTime(Date.now() + CHUNK_TIMESLICE_MS);
      for (const ch of [camera, audio]) await sendChunk(ch, 1, 100, 100);
      await new Promise((r) => setTimeout(r, 0));

      // One line per file, and each guest file is still acknowledged from the folder write.
      expect(warns).toHaveLength(2);
      expect(warns.every((m) => m.includes('Crash protection stopped'))).toBe(true);
      for (const ch of [camera, audio]) {
        const acks = ch.sent.map((m) => JSON.parse(m as string)).filter((m) => m.type === 'ack');
        expect(acks.at(-1)).toEqual({ type: 'ack', recordingId: 'rec', uptoIdx: 1, uptoOffset: 200 });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a later guest's clock-sync numbers in its camera note", async () => {
    const h = await hostHandles([], [], []);
    const { journal } = fakeJournal();
    h.journal = journal;
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    const b = fakeChannel();
    await bindHostGuestChannel(b, h, 'peer-b');

    const start = Date.now() - 100;
    await b.deliver(JSON.stringify({ type: 'recording_meta', recordingId: 'g', guestStartHostMs: start, rttMs: 12 }));

    expect(journal.notes.files.find((f) => f.file === 'guest2_rec.mp4')).toMatchObject({
      guestStartHostMs: start,
      rttMs: 12,
    });
  });

  it('refuses a channel-label key that is not letters, digits and hyphens', async () => {
    const opened: string[] = [];
    const h = await hostHandles(opened, [], []);
    const { journal } = fakeJournal();
    h.journal = journal;

    const hostile = ['../../../etc/passwd', 'a/b\\c:d*e?"<>|', '', 'guest_rec.mp4', '\u{1F4A5}\u0000\n', 'k'.repeat(65)];
    for (const key of hostile) {
      const cam = fakeChannel(`recording#${key}`);
      const wav = fakeChannel(`recording-audio#${key}`);
      await bindHostGuestChannel(cam, h, 'peer-a');
      await bindHostAudioChannel(wav, h, 'peer-a');
      expect(cam.onmessage).toBeNull();
      expect(wav.onmessage).toBeNull();
    }
    expect(h.guestSlots?.size ?? 0).toBe(0);
    expect(opened).toEqual([]);
    expect(journal.notes.files).toEqual([]);

    // A recording id is a key, and so is the Room's peer id when the label has none.
    const keyed = fakeChannel('recording-audio#11111111-1111-4111-8111-111111111111');
    await bindHostAudioChannel(keyed, h, 'peer-a');
    const plain = fakeChannel('recording-audio');
    await bindHostAudioChannel(plain, h, 'peer-b');
    expect(keyed.onmessage).not.toBeNull();
    expect(plain.onmessage).not.toBeNull();
    expect(opened).toEqual(['guest_rec.wav', 'guest2_rec.wav']);
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
 * useRoom.ts keeps the recording channels that arrived while no take was
 * running in one pending list, and binds every entry it holds when Record is
 * clicked; a resume binds them instead. It used not to be cleared between
 * takes. A guest mints a fresh recordingId (the channel-label key) per take,
 * so a dead take-1 channel left pending claims slot 0 in take 2 before the
 * real take-2 channel arrives — opening a WAV nobody writes, and pushing the
 * guest's real files to slot 1.
 *
 * This models useRoom's exact sequence (list append on channel arrival, bind at
 * Record time, forgetting the list for the next take) with a plain Map standing
 * in for the private pending list, using the real bindHostAudioChannel/
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
    // Mirrors useRoom.ts's private pending list: one entry per guest and kind.
    const audioChannelsRef = new Map<string, RTCDataChannel>();

    // Take 1: the guest's WAV channel arrives and is stored (onDataChannel).
    audioChannelsRef.set('peer-a', fakeChannel('recording-audio#R1'));

    // newTake(): forgetPreTakeGuestChannels empties the pending list here.
    audioChannelsRef.clear();

    // Take 2 starts with fresh handles (a new startHostRecording call).
    const opened: string[] = [];
    const written: Written[] = [];
    const h2 = await hostHandlesFor('rec2', opened, written);

    // Record is clicked for take 2 before the guest's new channels arrive —
    // only whatever the pending list still holds gets bound here.
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

/**
 * After a reload, the take in the journal is picked up again: the same take id,
 * number, start time and slot map, each guest file reopened where the crash copy
 * got to, and each receiver seeded from the journal's position so the guest's
 * next fragment lands exactly where the file ends.
 */
describe('a take resumed from its journal', () => {
  const r1Note: ResumeNote = { file: 'guest_rec.mp4', kind: 'camera', key: 'R1', slot: 0 };
  const r2Note: ResumeNote = { file: 'guest2_rec.mp4', kind: 'camera', key: 'R2', slot: 1 };
  const r1Parts = { 'guest_rec.mp4': [{ offset: 0, size: 100 }, { offset: 100, size: 100 }] };
  const r1Position = { 'guest_rec.mp4': { nextIdx: 2, end: 200 } };

  it('replays the crash copy and continues the guest file with no gap', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir(opened, written),
      channels: [{ channel, peerId: 'peer-a' }],
    });

    expect(h.recordingId).toBe('rec');
    expect(h.take).toBe(1);
    expect(h.hostStartMs).toBe(1_700_000_000_000);
    expect(j.replayed).toEqual(['guest_rec.mp4']);
    // The folder holds the crashed parts before the receiver takes over.
    expect(written.filter((w) => w.file === 'guest_rec.mp4').map((w) => [w.position, w.bytes])).toEqual([
      [0, 100],
      [100, 100],
    ]);
    // The bind announces where the file ends, so the guest replays only the rest.
    expect(channel.sent.map((m) => JSON.parse(m as string))).toEqual([
      { type: 'resume_offset', recordingId: 'rec', lastByte: 200, lastIdx: 1 },
    ]);

    await sendChunk(channel, 2, 200, 100);
    await sendChunk(channel, 3, 300, 100);
    // The take ends normally: the guest's finalize lets endHostRecording close
    // the file instead of waiting out the tail timeout.
    await channel.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 400, sha256: 'a'.repeat(64) })
    );
    await endHostRecording(h);
    expect(written.filter((w) => w.file === 'guest_rec.mp4').map((w) => [w.position, w.bytes])).toEqual([
      [0, 100],
      [100, 100],
      [200, 100],
      [300, 100],
    ]);
    expect(opened).toEqual(['guest_rec.mp4']);
  });

  it('withholds the written digest of a resumed file, so its verdict is not a false mismatch', async () => {
    const written: Written[] = [];
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], written),
      channels: [{ channel, peerId: 'peer-a' }],
    });
    await sendChunk(channel, 2, 200, 100);
    await channel.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 300, sha256: 'a'.repeat(64) })
    );

    const check = (await collectFileChecks(h)).get('guest_rec.mp4');
    expect(check?.recovered).toBe(true);
    // What this tab hashed is only the part after the crash, so the report must
    // withhold it rather than let the verdict call the file a mismatch.
    expect((await collectGuestReports(h, undefined)).find((g) => g.slot === 0)?.sha256Written).toBeUndefined();
    expect(fileVerdict(check, 'R1')).toEqual({
      status: 'unverified',
      text: 'Not verified. This file was rebuilt from the browser’s crash copy, so there was no checksum to compare.',
    });
  });

  it('digests the whole resumed file when the note kept the state of its position', async () => {
    const written: Written[] = [];
    // The state a first receiver committed after fragments 0-1: 200 bytes.
    const prior = new StreamingSha256();
    prior.update(new Uint8Array(200));
    const j = resumeJournal([{ ...r1Note, sha256State: { nextIdx: 2, ...prior.toJSON() } }], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], written),
      channels: [{ channel, peerId: 'peer-a' }],
    });

    expect(await j.journal.file('guest_rec.mp4').position()).toEqual({ nextIdx: 2, end: 200 });
    await sendChunk(channel, 2, 200, 100);
    await sendChunk(channel, 3, 300, 100);

    const all = new Uint8Array(400);
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect((await collectGuestReports(h, undefined)).find((g) => g.slot === 0)?.sha256Written).toBe(expected);
  });

  it('reports no written digest for a resumed file whose note kept no state', async () => {
    const written: Written[] = [];
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], written),
      channels: [{ channel, peerId: 'peer-a' }],
    });

    await sendChunk(channel, 2, 200, 100);
    await sendChunk(channel, 3, 300, 100);

    expect((await collectGuestReports(h, undefined)).find((g) => g.slot === 0)?.sha256Written).toBeUndefined();
  });

  it('keeps the journal slots and keys, so each guest file keeps its own bytes', async () => {
    const written: Written[] = [];
    // The notes need not be in slot order, and the second guest's channel
    // arrives first: both times the slot comes from the note, not the arrival.
    const j = resumeJournal(
      [r2Note, r1Note],
      { ...r1Position, 'guest2_rec.mp4': { nextIdx: 1, end: 50 } },
      { ...r1Parts, 'guest2_rec.mp4': [{ offset: 0, size: 50 }] }
    );
    const c2 = fakeChannel('recording#R2');
    const c1 = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      // A caller that still holds the folder handle passes it instead of a picker.
      dir: fakeDir([], written),
      channels: [
        { channel: c2, peerId: 'peer-b' },
        { channel: c1, peerId: 'peer-a' },
      ],
    });

    expect(h.guestSlots?.get('R1')).toBe(0);
    expect(h.guestSlots?.get('R2')).toBe(1);
    expect(h.slotPeerIds?.get(1)).toBe('peer-b');

    await sendChunk(c2, 1, 50, 10);
    expect(written.filter((w) => w.file === 'guest2_rec.mp4').map((w) => [w.position, w.bytes])).toEqual([
      [0, 50],
      [50, 10],
    ]);
    expect(written.filter((w) => w.file === 'guest_rec.mp4' && w.position === 50)).toEqual([]);
  });

  it('withholds the written digest of a resumed extra slot too', async () => {
    const written: Written[] = [];
    const j = resumeJournal(
      [r1Note, r2Note],
      { ...r1Position, 'guest2_rec.mp4': { nextIdx: 1, end: 50 } },
      { ...r1Parts, 'guest2_rec.mp4': [{ offset: 0, size: 50 }] }
    );
    const c1 = fakeChannel('recording#R1');
    const c2 = fakeChannel('recording#R2');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], written),
      channels: [
        { channel: c1, peerId: 'peer-a' },
        { channel: c2, peerId: 'peer-b' },
      ],
    });
    await sendChunk(c2, 1, 50, 10);
    await c2.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 60, sha256: 'b'.repeat(64) })
    );

    const checks = await collectFileChecks(h);
    expect(checks.get('guest2_rec.mp4')?.recovered).toBe(true);
    expect((await collectGuestReports(h, undefined)).find((g) => g.slot === 1)?.sha256Written).toBeUndefined();
    expect(fileVerdict(checks.get('guest2_rec.mp4'), 'Guest 2')).toEqual({
      status: 'unverified',
      text: 'Not verified. This file was rebuilt from the browser’s crash copy, so there was no checksum to compare.',
    });
  });

  it('leaves a channel with no note, and a screen channel, untouched', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const r9 = fakeChannel('recording#R9');
    const screen = fakeChannel('recording-screen-1');
    const backup = fakeChannel('backup#R1');
    const other = fakeChannel('other#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir(opened, written),
      channels: [
        { channel: r9, peerId: 'peer-x' },
        { channel: screen, peerId: 'peer-y' },
        { channel: backup, peerId: 'peer-a' },
        { channel: other, peerId: 'peer-a' },
      ],
    });

    expect(r9.onmessage).toBeNull();
    expect(screen.onmessage).toBeNull();
    expect(backup.onmessage).toBeNull();
    expect(other.onmessage).toBeNull();
    expect(opened).toEqual(['guest_rec.mp4']);
    expect(h.guestSlots?.has('R9')).toBe(false);
    await sendChunk(r9, 0, 0, 10);
    expect(written.filter((w) => w.bytes === 10)).toEqual([]);
  });

  it('counts the journal guest screen segments so the next share does not overwrite one', async () => {
    const opened: string[] = [];
    // The host's own screen file is not a guest segment, even if one ever lands
    // in the notes: only `guest_screen` names are counted here.
    const j = resumeJournal([
      { file: 'guest_screen_rec.mp4', kind: 'screen' },
      { file: 'host_screen_rec.mp4', kind: 'screen' },
    ]);
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir(opened, []),
      channels: [],
    });

    expect(h.guestScreenSegments).toBe(1);
    expect(h.screenSegment).toBeUndefined();
    await bindHostScreenChannel(fakeChannel('recording-screen-1'), h);
    expect(opened).toContain('guest_screen_rec_2.mp4');
    // The resumed take carries its journal, so the new segment is crash-safe too.
    expect(j.journal.notes.files.map((f) => f.file)).toContain('guest_screen_rec_2.mp4');
  });

  it('ignores hostile channel labels and peer ids without throwing', async () => {
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const hostileChannels = [
      { channel: fakeChannel(''), peerId: '' },
      { channel: fakeChannel('recording\n#R1'), peerId: 'peer-1' },
      { channel: fakeChannel('recording#"\'<script>'), peerId: 'NaN' },
      { channel: fakeChannel('other#R1'), peerId: '-1' },
      { channel: fakeChannel('recording#R1'), peerId: '\n"\'/../bad' },
    ];
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], []),
      channels: hostileChannels,
    });
    expect(h.slotPeerIds?.get(0)).toBe('\n"\'/../bad');
  });

  it('puts a resumed slot-0 WAV master where a fresh take keeps it', async () => {
    const written: Written[] = [];
    const j = resumeJournal(
      [{ file: 'guest_rec.wav', kind: 'wav', key: 'R1', slot: 0 }],
      { 'guest_rec.wav': { nextIdx: 1, end: 50 } },
      { 'guest_rec.wav': [{ offset: 0, size: 50 }] }
    );
    const channel = fakeChannel('recording-audio#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], written),
      channels: [{ channel, peerId: 'peer-a' }],
    });

    expect(h.guestWavWriter?.fileName).toBe('guest_rec.wav');
    expect(h.wavReceiver?.lastOffsetValue).toBe(50);
    expect(h.receiver).toBeUndefined();
    // collectFileChecks and collectTrackHealth read the WAV through this entry;
    // it is not an extra file, so it is not listed twice at the end either.
    expect(h.guestReceivers?.has('R1:wav')).toBe(true);
    expect(h.extraWriters ?? []).toEqual([]);

    await sendChunk(channel, 1, 50, 10);
    expect(written.filter((w) => w.file === 'guest_rec.wav').map((w) => [w.position, w.bytes])).toEqual([
      [0, 50],
      [50, 10],
    ]);
  });

  it('surfaces a write failure on a resumed file', async () => {
    const errors: unknown[] = [];
    const failingDir = {
      getFileHandle: async (name: string) => ({
        name,
        createWritable: async () => ({
          write: async () => {
            throw new Error('disk full');
          },
          close: async () => {},
        }),
      }),
    } as unknown as NonNullable<RecordingHandles['dir']>;
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      dir: failingDir,
      channels: [{ channel, peerId: 'peer-a' }],
      onError: (e) => errors.push(e),
    });

    await sendChunk(channel, 2, 200, 10);
    // The channel handler does not await the receiver, so let the write settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The folder refuses the replay first, then the live fragment; both reach
    // the caller.
    expect(errors.map((e) => (e as Error).message)).toContain('disk full');
  });

  it('surfaces the journal warning of a resumed receiver', async () => {
    const warns: string[] = [];
    const j = resumeJournal([r1Note], r1Position, r1Parts, true);
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], []),
      channels: [],
      onWarn: (m) => warns.push(m),
    });

    h.receiver?.flushAck();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warns[0]).toContain('Crash protection stopped');
  });

  it('ends a resumed take: every guest file the journal held is closed', async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const j = resumeJournal(
      [r1Note, r2Note],
      { ...r1Position, 'guest2_rec.mp4': { nextIdx: 1, end: 50 } },
      { ...r1Parts, 'guest2_rec.mp4': [{ offset: 0, size: 50 }] }
    );
    const c1 = fakeChannel('recording#R1');
    const c2 = fakeChannel('recording#R2');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir(opened, [], closed),
      channels: [
        { channel: c1, peerId: 'peer-a' },
        { channel: c2, peerId: 'peer-b' },
      ],
    });
    const finalized = (sha: string) =>
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 0, sha256: sha });
    await c1.deliver(finalized('one'));
    await c2.deliver(finalized('two'));

    await endHostRecording(h);
    expect(closed.sort()).toEqual(['guest2_rec.mp4', 'guest_rec.mp4']);
  });

  it('continues a file longer than the far-offset bound without refusing the guest', async () => {
    // The journal's end is already past the bound the live path measures from
    // zero. The guest's next fragment starts there, so the rule has to move
    // with the resume rather than read every honest first fragment as a jump.
    const end = MAX_OFFSET_JUMP_BYTES + 1024;
    const written: Written[] = [];
    const errors: unknown[] = [];
    const j = resumeJournal(
      [r1Note],
      { 'guest_rec.mp4': { nextIdx: 2, end } },
      // One committed byte at the file's end: the parts prove the extent the
      // position reports without the test building a 64 MiB buffer.
      { 'guest_rec.mp4': [{ offset: end - 1, size: 1 }] }
    );
    const channel = fakeChannel('recording#R1');
    await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], written),
      channels: [{ channel, peerId: 'peer-a' }],
      onError: (e) => errors.push(e),
    });

    await sendChunk(channel, 2, end, 1000);
    expect(written.filter((w) => w.file === 'guest_rec.mp4' && w.position === end)).toEqual([
      { file: 'guest_rec.mp4', position: end, bytes: 1000 },
    ]);
    expect(errors).toEqual([]);
  });

  it('still refuses a fragment far past the end of a resumed file', async () => {
    const end = MAX_OFFSET_JUMP_BYTES + 1024;
    const written: Written[] = [];
    const errors: unknown[] = [];
    const j = resumeJournal(
      [r1Note],
      { 'guest_rec.mp4': { nextIdx: 2, end } },
      { 'guest_rec.mp4': [{ offset: end - 1, size: 1 }] }
    );
    const channel = fakeChannel('recording#R1');
    await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], written),
      channels: [{ channel, peerId: 'peer-a' }],
      onError: (e) => errors.push(e),
    });

    await sendChunk(channel, 2, end + MAX_OFFSET_JUMP_BYTES + 1, 1000);
    expect((errors[0] as Error)?.message).toBe('A fragment arrived far past the end of the file.');
    expect(written.filter((w) => w.position === end + MAX_OFFSET_JUMP_BYTES + 1)).toEqual([]);
  });

  it('refuses a journal with no recording id before asking for a folder', async () => {
    const opened: string[] = [];
    let picked = false;
    const j = resumeJournal([]);
    j.journal.notes.recordingId = '';
    await expect(
      resumeHostRecording({
        localStream: emptyFakeStream(),
        journal: j.journal,
        directoryPicker: async () => {
          picked = true;
          return fakeDir(opened, []);
        },
        channels: [],
      })
    ).rejects.toThrow();
    expect(picked).toBe(false);
    expect(opened).toEqual([]);
    expect(j.replayed).toEqual([]);
  });

  it('matches no channel label to a note that has no key', async () => {
    const opened: string[] = [];
    const written: Written[] = [];
    const j = resumeJournal([{ file: 'guest_rec.mp4', kind: 'camera', slot: 0 }], r1Position, r1Parts);
    const channel = fakeChannel('recording#guest_rec.mp4');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir(opened, written),
      channels: [{ channel, peerId: 'peer-x' }],
    });

    // The file is still reopened and its slot restored, but a label that names
    // the file rather than a key the guest chose must not reach it.
    expect(h.guestSlots?.get('guest_rec.mp4')).toBe(0);
    expect(channel.onmessage).toBeNull();
    await sendChunk(channel, 2, 200, 10);
    expect(written.filter((w) => w.bytes === 10)).toEqual([]);
  });

  it('gives a new guest a slot above the highest restored one, not the map size', async () => {
    const opened: string[] = [];
    const j = resumeJournal(
      [
        { file: 'guest_rec.mp4', kind: 'camera', key: 'A', slot: 0 },
        { file: 'guest3_rec.mp4', kind: 'camera', key: 'C', slot: 2 },
      ],
      { 'guest_rec.mp4': { nextIdx: 1, end: 10 }, 'guest3_rec.mp4': { nextIdx: 1, end: 10 } },
      { 'guest_rec.mp4': [{ offset: 0, size: 10 }], 'guest3_rec.mp4': [{ offset: 0, size: 10 }] }
    );
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir(opened, []),
      channels: [],
    });

    await bindHostGuestChannel(fakeChannel('recording#D'), h, 'peer-d');
    expect(h.guestSlots?.get('D')).toBe(3);
    expect(opened).toContain('guest4_rec.mp4');
    expect(opened.filter((name) => name === 'guest3_rec.mp4')).toHaveLength(1);
  });

  it('reports a replay that stopped short and resumes from what landed', async () => {
    const errors: unknown[] = [];
    const written: Written[] = [];
    let writes = 0;
    const dir = {
      getFileHandle: async (name: string) => ({
        name,
        createWritable: async () => ({
          write: async (d: { position: number; data: ArrayBuffer | Blob }) => {
            writes += 1;
            if (writes === 2) throw new Error('disk full');
            written.push({
              file: name,
              position: d.position,
              bytes: d.data instanceof Blob ? d.data.size : d.data.byteLength,
            });
          },
          close: async () => {},
        }),
      }),
    } as unknown as NonNullable<RecordingHandles['dir']>;
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      dir,
      channels: [{ channel, peerId: 'peer-a' }],
      onError: (e) => errors.push(e),
    });

    expect(written).toEqual([{ file: 'guest_rec.mp4', position: 0, bytes: 100 }]);
    expect((errors[0] as Error)?.message).toContain('crash copy');
    // The guest is asked for the rest from where the file really ends, not from
    // the end the journal claims.
    expect(channel.sent.map((m) => JSON.parse(m as string))).toEqual([
      { type: 'resume_offset', recordingId: 'rec', lastByte: 100, lastIdx: 1 },
    ]);
  });

  it('keeps the other guests when one channel refuses the resume announcement', async () => {
    const errors: unknown[] = [];
    const j = resumeJournal(
      [r1Note, r2Note],
      { ...r1Position, 'guest2_rec.mp4': { nextIdx: 1, end: 50 } },
      { ...r1Parts, 'guest2_rec.mp4': [{ offset: 0, size: 50 }] }
    );
    const bad = fakeChannel('recording#R1');
    bad.send = () => {
      throw new Error('send failed');
    };
    const good = fakeChannel('recording#R2');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], []),
      channels: [
        { channel: bad, peerId: 'peer-a' },
        { channel: good, peerId: 'peer-b' },
      ],
      onError: (e) => errors.push(e),
    });

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('send failed');
    expect(good.onmessage).not.toBeNull();
    expect(h.slotPeerIds?.get(1)).toBe('peer-b');
  });

  it('reports a resumed file that stopped early as incomplete, not merely unverified', async () => {
    const written: Written[] = [];
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], written),
      channels: [{ channel, peerId: 'peer-a' }],
    });
    await channel.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 200, sha256: 'a'.repeat(64) })
    );
    await channel.deliver(JSON.stringify({ type: 'stream-abandoned', recordingId: 'rec' }));

    // The guest's own backup is the only whole copy of a file it stopped
    // sending, so the host must still be told to ask for it.
    const check = (await collectFileChecks(h)).get('guest_rec.mp4');
    expect(check?.received?.sha256Sent).toBeUndefined();
    const verdict = fileVerdict(check, 'R1');
    expect(verdict.status).toBe('incomplete');
    expect(verdict.text).toContain('Ask R1 for the backup');
  });

  it('reports a resumed file whose guest never came back as incomplete', async () => {
    const written: Written[] = [];
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], written),
      channels: [{ channel, peerId: 'peer-a' }],
    });

    const verdict = fileVerdict((await collectFileChecks(h)).get('guest_rec.mp4'), 'R1');
    expect(verdict.status).toBe('incomplete');
    expect(verdict.text).toContain('No finish signal arrived from R1');
  });

  it('does not wait for a resumed file whose guest never came back', async () => {
    vi.useFakeTimers();
    try {
      const j = resumeJournal(
        [r1Note, r2Note],
        { ...r1Position, 'guest2_rec.mp4': { nextIdx: 1, end: 50 } },
        { ...r1Parts, 'guest2_rec.mp4': [{ offset: 0, size: 50 }] }
      );
      const c1 = fakeChannel('recording#R1');
      const h = await resumeHostRecording({
        localStream: emptyFakeStream(),
        journal: j.journal,
        directoryPicker: async () => fakeDir([], []),
        channels: [{ channel: c1, peerId: 'peer-a' }],
      });
      await c1.deliver(
        JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 300, sha256: 'a'.repeat(64) })
      );

      let settled = false;
      const done = endHostRecording(h).then(() => {
        settled = true;
      });
      // The 45 s tail is meant for a channel that is still sending; guest 2's
      // file has no channel at all, so the save must not sit on it.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(true);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves the next screen share past the highest segment the notes name', async () => {
    const opened: string[] = [];
    const j = resumeJournal([{ file: 'guest_screen_rec_2.mp4', kind: 'screen', segment: 2 }]);
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir(opened, []),
      channels: [],
    });

    await bindHostScreenChannel(fakeChannel('recording-screen-1'), h);
    expect(opened).toContain('guest_screen_rec_3.mp4');
    expect(opened).not.toContain('guest_screen_rec_2.mp4');
  });

  it('never replaces a screen file the folder already holds after a resume', async () => {
    const opened: string[] = [];
    const probes: string[] = [];
    const j = resumeJournal(
      [r1Note, { file: 'guest_screen_rec_2.mp4', kind: 'screen', segment: 2 }],
      r1Position,
      r1Parts
    );
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      // Segment 3 was handed out before the crash but left no note: only the
      // folder itself knows its name is taken.
      dir: fakeDir(opened, [], [], ['guest_screen_rec_3.mp4'], probes),
      channels: [],
    });
    // The resume looks its own files up in the folder; this is about the share's probes.
    probes.length = 0;

    await bindHostScreenChannel(fakeChannel('recording-screen-1'), h);
    expect(opened).toContain('guest_screen_rec_4.mp4');
    expect(opened).not.toContain('guest_screen_rec_3.mp4');
    expect(probes).toEqual(['guest_screen_rec_3.mp4', 'guest_screen_rec_4.mp4']);
  });

  it('leaves a fresh take to open its own screen segment number', async () => {
    const opened: string[] = [];
    const probes: string[] = [];
    const h = {
      recordingId: 'rec',
      dir: fakeDir(opened, [], [], ['guest_screen_rec.mp4'], probes),
    } as RecordingHandles;

    await bindHostScreenChannel(fakeChannel('recording-screen-1'), h);
    expect(opened).toEqual(['guest_screen_rec.mp4']);
    expect(probes).toEqual([]);
  });

  /**
   * A folder with the File System Access rule that matters here: a file opened
   * for writing replaces the one on disk when it is closed. `readable: false`
   * is a folder whose files tell their length and cannot be read back, and
   * `refuseWrite` makes a write to a file reject.
   */
  function swapFolder(
    seed: Record<string, number>,
    opts: { readable?: boolean; refuseWrite?: (position: number, bytes: number) => boolean } = {}
  ) {
    const sizes = new Map(Object.entries(seed));
    const writes: [string, number, number][] = [];
    const dir = {
      getFileHandle: async (name: string, o?: { create?: boolean }) => {
        if (!sizes.has(name)) {
          if (!o?.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
          sizes.set(name, 0);
        }
        return {
          name,
          getFile: async () =>
            opts.readable === false ? { size: sizes.get(name)! } : new Blob([new Uint8Array(sizes.get(name)!)]),
          createWritable: async () => {
            let end = 0;
            return {
              write: async (d: { position: number; data: ArrayBuffer | Blob }) => {
                const bytes = d.data instanceof Blob ? d.data.size : d.data.byteLength;
                if (opts.refuseWrite?.(d.position, bytes)) throw new Error('disk full');
                writes.push([name, d.position, bytes]);
                end = Math.max(end, d.position + bytes);
              },
              close: async () => {
                sizes.set(name, end);
              },
            };
          },
        };
      },
    } as unknown as NonNullable<RecordingHandles['dir']>;
    return { dir, writes, size: (name: string) => sizes.get(name) };
  }

  it('carries over what the folder holds beyond the crash copy, and continues the file', async () => {
    // The closing page committed 300 bytes of the file; the crash copy trails at 200.
    const folder = swapFolder({ 'guest_rec.mp4': 300 });
    const errors: unknown[] = [];
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      dir: folder.dir,
      channels: [{ channel, peerId: 'peer-a' }],
      onError: (e) => errors.push(e),
    });

    expect(errors).toEqual([]);
    // What the folder held goes in first, then the crash copy's parts over it.
    expect(folder.writes).toEqual([
      ['guest_rec.mp4', 0, 300],
      ['guest_rec.mp4', 0, 100],
      ['guest_rec.mp4', 100, 100],
    ]);
    // The guest is still asked for everything after the crash copy.
    expect(channel.sent.map((m) => JSON.parse(m as string))).toEqual([
      { type: 'resume_offset', recordingId: 'rec', lastByte: 200, lastIdx: 1 },
    ]);

    await sendChunk(channel, 2, 200, 100);
    await sendChunk(channel, 3, 300, 100);
    (channel as unknown as { readyState: string }).readyState = 'closed';
    await endHostRecording(h);
    expect(folder.size('guest_rec.mp4')).toBe(400);
  });

  it('keeps every byte the folder held when the guest never sends again', async () => {
    // The crash copy can replay 200 bytes of the first file and nothing of the second.
    const folder = swapFolder({ 'guest_rec.mp4': 300, 'guest2_rec.mp4': 300 });
    const errors: unknown[] = [];
    const j = resumeJournal([r1Note, r2Note], r1Position, r1Parts);
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      dir: folder.dir,
      channels: [],
      onError: (e) => errors.push(e),
    });
    await endHostRecording(h);

    expect(errors).toEqual([]);
    expect(folder.size('guest_rec.mp4')).toBe(300);
    expect(folder.size('guest2_rec.mp4')).toBe(300);
  });

  it('leaves a longer folder file as it is when its bytes cannot be carried over, and says so', async () => {
    // The first file cannot be read back; the copy of the second is refused.
    const unreadable = swapFolder({ 'guest_rec.mp4': 300 }, { readable: false });
    const full = swapFolder({ 'guest2_rec.mp4': 300 }, { refuseWrite: (position, bytes) => bytes === 300 });
    for (const [folder, note, file] of [
      [unreadable, r1Note, 'guest_rec.mp4'],
      [full, r2Note, 'guest2_rec.mp4'],
    ] as const) {
      const errors: unknown[] = [];
      const j = resumeJournal([note], r1Position, r1Parts);
      const channel = fakeChannel(`recording#${note.key}`);
      const h = await resumeHostRecording({
        localStream: emptyFakeStream(),
        journal: j.journal,
        dir: folder.dir,
        channels: [{ channel, peerId: 'peer-a' }],
        onError: (e) => errors.push(e),
      });

      expect(errors.map((e) => (e as Error).message)).toEqual([expect.stringContaining(file)]);
      expect(j.replayed).toEqual([]);
      expect(channel.onmessage).toBeNull();

      // The guest reconnects during the resumed take: its file is still not opened.
      const again = fakeChannel(`recording#${note.key}`);
      await bindHostGuestChannel(again, h, 'peer-a2');
      expect(again.onmessage).toBeNull();

      await endHostRecording(h);
      expect(folder.size(file)).toBe(300);
    }
  });

  it('continues a folder file that is not longer than the crash copy without copying it', async () => {
    const folder = swapFolder({ 'guest_rec.mp4': 200 });
    const errors: unknown[] = [];
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      dir: folder.dir,
      channels: [{ channel, peerId: 'peer-a' }],
      onError: (e) => errors.push(e),
    });
    await sendChunk(channel, 2, 200, 100);
    (channel as unknown as { readyState: string }).readyState = 'closed';
    await endHostRecording(h);

    expect(errors).toEqual([]);
    expect(folder.writes).toEqual([
      ['guest_rec.mp4', 0, 100],
      ['guest_rec.mp4', 100, 100],
      ['guest_rec.mp4', 200, 100],
    ]);
    expect(folder.size('guest_rec.mp4')).toBe(300);
  });

  it('reads a resumed file whose replay stopped short as incomplete, whatever digest the note kept', async () => {
    const fragment = (i: number) => Uint8Array.from({ length: 100 }, (_, k) => (i * 31 + k) & 0xff);
    const hex = async (...parts: Uint8Array[]) => {
      const all = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
      parts.reduce((at, part) => (all.set(part, at), at + part.length), 0);
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    };
    // The state the first receiver committed after fragments 0 and 1.
    const prior = new StreamingSha256();
    prior.update(fragment(0));
    prior.update(fragment(1));
    let writes = 0;
    const dir = {
      getFileHandle: async (name: string) => ({
        name,
        createWritable: async () => ({
          write: async () => {
            writes += 1;
            if (writes === 2) throw new Error('disk full'); // the folder refuses the second part
          },
          close: async () => {},
        }),
      }),
    } as unknown as NonNullable<RecordingHandles['dir']>;
    const j = resumeJournal([{ ...r1Note, sha256State: { nextIdx: 2, ...prior.toJSON() } }], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      dir,
      channels: [{ channel, peerId: 'peer-a' }],
      onError: () => {},
    });

    // The guest carries on and finishes with the true digest of all it sent.
    for (const i of [2, 3]) {
      await channel.deliver(encodeChunkHeader({ idx: i, offset: i * 100, size: 100, ts: 0 }));
      await channel.deliver(fragment(i).buffer);
    }
    const sent = await hex(fragment(0), fragment(1), fragment(2), fragment(3));
    await channel.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 400, sha256: sent })
    );

    const verdict = fileVerdict((await collectFileChecks(h)).get('guest_rec.mp4'), 'Bob');
    expect(verdict.status).toBe('incomplete');
    expect(verdict.text).toContain('Ask Bob for the backup');
  });

  it('keeps the name and the start offset the notes hold for a resumed guest file', async () => {
    const j = resumeJournal(
      [
        { ...r1Note, who: 'Bob', guestStartHostMs: 1_700_000_000_500, rttMs: 12 },
        { ...r2Note, who: 'Vera', guestStartHostMs: 1_700_000_001_000, rttMs: 30 },
      ],
      { ...r1Position, 'guest2_rec.mp4': { nextIdx: 1, end: 50 } },
      { ...r1Parts, 'guest2_rec.mp4': [{ offset: 0, size: 50 }] }
    );
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      dir: fakeDir([], []),
      channels: [],
    });

    // Both guests have left: the room has no name for either.
    const guests = await collectGuestReports(h, () => undefined);
    expect(guests.map((g) => [g.slot, g.name, g.startHostMs, g.rttMs])).toEqual([
      [0, 'Bob', 1_700_000_000_500, 12],
      [1, 'Vera', 1_700_000_001_000, 30],
    ]);
  });

  it('gives two guest screen shares that arrive together after a resume a file each', async () => {
    const opened: string[] = [];
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      // Segment 1 was handed out before the crash and left no note.
      dir: fakeDir(opened, [], [], ['guest_screen_rec.mp4']),
      channels: [],
    });
    opened.length = 0;

    await Promise.all([
      bindHostScreenChannel(fakeChannel('recording-screen-1'), h, undefined, 'peer-a'),
      bindHostScreenChannel(fakeChannel('recording-screen-1'), h, undefined, 'peer-b'),
    ]);

    expect(opened.slice().sort()).toEqual(['guest_screen_rec_2.mp4', 'guest_screen_rec_3.mp4']);
  });

  it('refuses a screen share when the folder has no free name for it, once', async () => {
    const opened: string[] = [];
    const lookups: string[] = [];
    const errors: unknown[] = [];
    // A folder that already holds every name it is asked about.
    const dir = {
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (opts?.create) opened.push(name);
        else lookups.push(name);
        return { name, createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
      },
    } as unknown as NonNullable<RecordingHandles['dir']>;
    const j = resumeJournal([{ file: 'guest_screen_rec_2.mp4', kind: 'screen', segment: 2 }]);
    const h = await resumeHostRecording({ localStream: emptyFakeStream(), journal: j.journal, dir, channels: [] });
    lookups.length = 0;

    const first = fakeChannel('recording-screen-1');
    const second = fakeChannel('recording-screen-2');
    await bindHostScreenChannel(first, h, (e) => errors.push(e), 'peer-a');
    await bindHostScreenChannel(second, h, (e) => errors.push(e), 'peer-a');

    // Fifty names asked for each share, none opened, nothing bound.
    expect(lookups).toHaveLength(100);
    expect(opened).toEqual([]);
    expect(first.onmessage).toBeNull();
    expect(second.onmessage).toBeNull();
    expect(h.screenWriters ?? []).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(recordingErrorMessage(errors[0])).toBe(
      'A screen share was not saved here: the folder has no free file name left for it. The sharer has it in their own backup.'
    );
  });

  it('reads a resumed file the guest finished without sending anything after the reload as incomplete', async () => {
    const j = resumeJournal([r1Note], r1Position, r1Parts);
    const channel = fakeChannel('recording#R1');
    const h = await resumeHostRecording({
      localStream: emptyFakeStream(),
      journal: j.journal,
      directoryPicker: async () => fakeDir([], []),
      channels: [{ channel, peerId: 'peer-a' }],
    });
    // The guest says it has sent everything, and nothing of it arrived here.
    await channel.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 900, sha256: 'a'.repeat(64) })
    );

    const check = (await collectFileChecks(h)).get('guest_rec.mp4');
    expect(check?.recovered).toBeUndefined();
    const verdict = fileVerdict(check, 'Bob');
    expect(verdict.status).toBe('incomplete');
    expect(verdict.text).toContain('Ask Bob for the backup');
  });

  it('reads a resumed file whose receiver gave up on a gap as incomplete, though bytes arrived after the reload', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const errors: string[] = [];
      const j = resumeJournal([r1Note], r1Position, r1Parts);
      const channel = fakeChannel('recording#R1');
      const h = await resumeHostRecording({
        localStream: emptyFakeStream(),
        journal: j.journal,
        directoryPicker: async () => fakeDir([], []),
        channels: [{ channel, peerId: 'peer-a' }],
        onError: (e) => errors.push((e as Error).message),
      });
      // The next fragment arrives; the guest no longer holds the ones after it.
      await sendChunk(channel, 2, 200, 100);
      for (let i = 0; i < 7; i++) {
        vi.setSystemTime(Date.now() + 2100);
        await sendChunk(channel, 9 + i, 900 + i * 100, 100);
      }
      await channel.deliver(
        JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 1600, sha256: 'a'.repeat(64) })
      );

      expect(errors).toEqual(["A guest's recording could not be continued here. Their own backup has it."]);
      const check = (await collectFileChecks(h)).get('guest_rec.mp4');
      expect(check?.recovered).toBeUndefined();
      const verdict = fileVerdict(check, 'Bob');
      expect(verdict.status).toBe('incomplete');
      expect(verdict.text).toContain('Ask Bob for the backup');
    } finally {
      vi.useRealTimers();
    }
  });
});

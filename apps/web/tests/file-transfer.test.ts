import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackupIntake, BackupSend, type BackupTransfer } from '@/hooks/backup-return';
import { MAX_SHARED_FILE_BYTES, SHARED_FILE_ID } from '@/lib/shared-file';
import { fakeChannel, fakeFolder, fakePair, flush, framesFor } from './backup-fakes';

// jsdom ships no Blob.prototype.arrayBuffer, and the one a real browser has is
// what a send reads its pieces with.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

const ROOM = 'abc-defg-hij';
const ID = 'file-3f2b8c1e-9a4d-4c6b-8f1e-2d7a9b0c5e4f';
const BACKUP_ID = `openmeet-backup-1700000000000-${ROOM}.mp4`;
const SAVED = 'shared_alice_headshot.jpg';
const NO_COPY = JSON.stringify({
  type: 'recording-finalized',
  recordingId: '',
  totalBytes: 0,
  sha256: '',
});

const offer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'backup_offer', size: 1000, key: 'k1', name: 'Headshot.JPG', ...over });
const finalized = (totalBytes: number, sha256: string) =>
  JSON.stringify({ type: 'recording-finalized', recordingId: ID, totalBytes, sha256 });

function bytesOf(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

function intakeFor() {
  const state: { items: BackupTransfer[] } = { items: [] };
  const intake = new BackupIntake({
    room: ROOM,
    onChange: (items) => {
      state.items = items;
    },
  });
  return { state, intake };
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

/** One offer from Alice on a channel with this key, as the host's page lists it. */
async function offered(over: Record<string, unknown> = {}, key = ID) {
  const { state, intake } = intakeFor();
  const ch = fakeChannel(`backup#${key}`);
  intake.offer(ch, { peerId: 'p1', name: 'Alice' });
  ch.deliver(offer(over));
  await flush();
  return { state, intake, ch };
}

describe('BackupIntake taking a picked file', () => {
  it('lists it with the name it will get in the folder, and answers nothing yet', async () => {
    const { state, ch } = await offered();
    expect(state.items).toEqual([
      { id: ID, kind: 'file', size: 1000, status: 'offered', percent: 0, from: 'Alice', name: SAVED },
    ]);
    expect(ch.sent).toEqual([]);
  });

  const turnedAway: { what: string; over: Record<string, unknown> }[] = [
    { what: 'a program', over: { name: 'setup.exe' } },
    { what: 'a web page', over: { name: 'page.html' } },
    { what: 'a file with no name', over: { name: undefined } },
    { what: 'a name that is not text', over: { name: { length: 3 } } },
    { what: 'a file over the limit', over: { size: MAX_SHARED_FILE_BYTES + 1 } },
  ];
  it.each(turnedAway)('turns $what away before the host is asked anything', async ({ over }) => {
    const { state, ch } = await offered(over);
    expect(state.items).toEqual([]);
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it('takes a file of exactly the limit', async () => {
    const { state } = await offered({ size: MAX_SHARED_FILE_BYTES });
    expect(state.items.map((t) => t.size)).toEqual([MAX_SHARED_FILE_BYTES]);
  });

  it('counts the limit in decimal megabytes: 100,000,000 bytes is taken, one more is not', async () => {
    const { state } = await offered({ size: 100_000_000 });
    expect(state.items.map((t) => t.size)).toEqual([100_000_000]);
    const over = await offered({ size: 100_000_001 });
    expect(over.state.items).toEqual([]);
  });

  it('refuses a channel whose key is neither a backup’s name nor a file id', async () => {
    const { state, ch } = await offered({}, 'file-../../etc/passwd');
    expect(state.items).toEqual([]);
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it('holds a returned backup to none of this: no name, no type, no size limit', async () => {
    const { state } = await offered({ name: 'setup.exe', size: MAX_SHARED_FILE_BYTES + 1 }, BACKUP_ID);
    expect(state.items).toEqual([
      {
        id: BACKUP_ID,
        kind: 'camera',
        size: MAX_SHARED_FILE_BYTES + 1,
        status: 'offered',
        percent: 0,
        from: 'Alice',
      },
    ]);
  });

  it('writes nothing before the host accepts, then saves it under that name, verified, with no note', async () => {
    const payload = bytesOf(200_000);
    const { frames, sha256 } = await framesFor(payload);
    const { state, intake, ch } = await offered({ size: payload.byteLength });
    const folder = fakeFolder();

    // Bytes that arrive before the host said yes go nowhere.
    for (const f of frames) ch.deliver(f);
    await settle();
    expect(folder.calls).toEqual([]);
    expect(ch.sent).toEqual([]);

    await intake.accept(folder, state.items);
    expect(JSON.parse(ch.sent[0] as string)).toEqual({
      type: 'resume_offset',
      recordingId: ID,
      lastByte: 0,
      lastIdx: -1,
    });
    for (const f of frames) ch.deliver(f);
    ch.deliver(finalized(payload.byteLength, sha256));
    await settle();

    // The one file, and no .json beside it.
    expect([...folder.files.keys()]).toEqual([SAVED]);
    expect(folder.files.get(SAVED)!.closed).toBe(true);
    expect(Array.from(folder.files.get(SAVED)!.bytes)).toEqual(Array.from(payload));
    expect(state.items).toEqual([
      expect.objectContaining({ status: 'saved', percent: 100, name: SAVED }),
    ]);
    expect(JSON.parse(ch.sent.at(-1) as string)).toEqual({
      type: 'recording-finalized',
      recordingId: ID,
      totalBytes: payload.byteLength,
      sha256,
    });
  });

  it('numbers the name when the folder already holds it, and shows the host the numbered one', async () => {
    const payload = bytesOf(1000);
    const { frames, sha256 } = await framesFor(payload);
    const { state, intake, ch } = await offered();
    const folder = fakeFolder();
    folder.files.set(SAVED, { bytes: new Uint8Array([9]), closed: true });

    await intake.accept(folder, state.items);
    for (const f of frames) ch.deliver(f);
    ch.deliver(finalized(1000, sha256));
    await settle();

    expect(Array.from(folder.files.get(SAVED)!.bytes)).toEqual([9]);
    expect(folder.files.get('shared_alice_headshot_2.jpg')!.closed).toBe(true);
    expect(state.items).toEqual([
      expect.objectContaining({ status: 'saved', name: 'shared_alice_headshot_2.jpg' }),
    ]);
  });

  it('removes a file that fails its check, and tells its sender', async () => {
    const payload = bytesOf(200_000);
    const { frames } = await framesFor(payload);
    const { state, intake, ch } = await offered({ size: payload.byteLength });
    const folder = fakeFolder();
    await intake.accept(folder, state.items);

    for (const f of frames) ch.deliver(f);
    ch.deliver(finalized(payload.byteLength, 'f'.repeat(64)));
    await settle();

    expect(state.items.map((t) => t.status)).toEqual(['failed']);
    expect(folder.files.size).toBe(0);
    expect(folder.removed).toEqual([SAVED]);
    expect(ch.sent).toContain(NO_COPY);
  });

  it('keeps nothing of a file that sends more than it declared', async () => {
    const { frames } = await framesFor(bytesOf(200_000));
    // Room for the first 64 KiB fragment and not for the second.
    const { state, intake, ch } = await offered({ size: 70_000 });
    const folder = fakeFolder();
    await intake.accept(folder, state.items);

    for (const f of frames) ch.deliver(f);
    await settle();

    expect(state.items.map((t) => t.status)).toEqual(['failed']);
    expect(folder.files.size).toBe(0);
  });

  it('declines only the offers it is handed', async () => {
    const { state, intake } = intakeFor();
    const file = fakeChannel(`backup#${ID}`);
    intake.offer(file, { peerId: 'p1', name: 'Alice' });
    file.deliver(offer());
    const backup = fakeChannel(`backup#${BACKUP_ID}`);
    intake.offer(backup, { peerId: 'p1', name: 'Alice' });
    backup.deliver(offer({ key: 'k2' }));
    await flush();
    expect(state.items.map((t) => t.kind)).toEqual(['file', 'camera']);

    intake.decline(state.items.filter((t) => t.kind === 'file'));

    expect(state.items.map((t) => t.kind)).toEqual(['camera']);
    expect(file.sent).toEqual([NO_COPY]);
    expect(file.readyState).toBe('closed');
    expect(backup.readyState).toBe('open');
  });
});

describe('BackupSend with a picked file', () => {
  it('travels under an id of its own and names itself in its offer', () => {
    const file = new File([bytesOf(10)], 'Headshot.JPG');
    const ch = fakeChannel();
    const send = new BackupSend({ file, shared: true });
    send.attach(ch);

    expect(send.item).toEqual({
      id: expect.stringMatching(SHARED_FILE_ID),
      kind: 'file',
      size: 10,
      status: 'offered',
      percent: 0,
      name: 'Headshot.JPG',
    });
    expect(JSON.parse(ch.sent[0] as string)).toEqual({
      type: 'backup_offer',
      size: 10,
      key: expect.any(String),
      name: 'Headshot.JPG',
    });
    // The same file picked twice is two transfers.
    expect(new BackupSend({ file, shared: true }).item.id).not.toBe(send.item.id);

    // Giving up names the transfer by its id, never by the file's name.
    send.cancel();
    expect(JSON.parse(ch.sent.at(-1) as string)).toEqual({
      type: 'stream-abandoned',
      recordingId: send.item.id,
      lastIdx: -1,
    });
  });

  it('asks a rebuilt connection for the file by its id, never by its name', () => {
    const file = new File([bytesOf(10)], 'Headshot.JPG');
    const first = fakeChannel();
    const send = new BackupSend({ file, shared: true });
    send.attach(first);
    first.deliver(JSON.stringify({ type: 'resume_offset', recordingId: send.item.id, lastByte: 0, lastIdx: -1 }));

    const second = fakeChannel();
    send.attach(second);
    expect(JSON.parse(second.sent[0] as string)).toEqual({
      type: 'resume_query',
      recordingId: send.item.id,
      key: JSON.parse(first.sent[0] as string).key,
    });
    send.cancel();
  });

  it('leaves a backup’s id and offer as they were', () => {
    const ch = fakeChannel();
    const send = new BackupSend({ file: new File([bytesOf(10)], BACKUP_ID) });
    send.attach(ch);

    expect(send.item.id).toBe(BACKUP_ID);
    expect(JSON.parse(ch.sent[0] as string)).toEqual({
      type: 'backup_offer',
      size: 10,
      key: expect.any(String),
    });
  });
});

describe('a picked file, from its sender to the host’s folder', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Runs queued microtasks, due timers and the jsdom file reads they started. */
  async function tick(ms = 0): Promise<void> {
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(ms);
      await new Promise((r) => setImmediate(r));
    }
  }

  it('arrives whole, and both ends call it saved', async () => {
    const bytes = bytesOf(300_000);
    const send = new BackupSend({ file: new File([bytes], 'Slides (v2).PDF'), shared: true });
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(`backup#${send.item.id}`);
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    send.attach(guest);
    await tick();
    expect(state.items.map((t) => [t.status, t.name])).toEqual([
      ['offered', 'shared_alice_slides-v2.pdf'],
    ]);

    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);

    expect(await send.done).toBe('saved');
    // The file's own name left this side once, in the offer; every message
    // that names the transfer names it by its id.
    const named = guest.sent
      .filter((m): m is string => typeof m === 'string' && m.includes('"recordingId"'))
      .map((m) => (JSON.parse(m) as { recordingId: unknown }).recordingId);
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set([send.item.id]));
    expect(send.item).toMatchObject({ status: 'saved', percent: 100, name: 'Slides (v2).PDF' });
    expect(state.items.map((t) => t.status)).toEqual(['saved']);
    expect(Array.from(folder.files.get('shared_alice_slides-v2.pdf')!.bytes)).toEqual(
      Array.from(bytes)
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DC_BUFFERED_HIGH_WATERMARK, DC_BUFFERED_LOW_WATERMARK, decodeChunkHeader } from '@openmeet/protocol';
import {
  BACKUP_READ_BYTES,
  BackupIntake,
  BackupSend,
  attachBackupSends,
  type BackupTransfer,
} from '@/hooks/backup-return';
import { fakeChannel, fakeFolder, fakePair, framesFor, type FakeChannel } from './backup-fakes';

// jsdom ships no Blob.prototype.arrayBuffer, and the one a real browser has is
// what the pump reads slices with.
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
const NAME = `openmeet-backup-1700000000000-${ROOM}.mp4`;
const LABEL = `backup#${NAME}`;
const HOST_FILE = 'backup_alice_camera_20231114T221320000Z.mp4';
const HOST_NOTE = HOST_FILE.replace(/\.[^.]+$/, '.json');
// A little over three whole slices, so the last read ends short of one.
const FILE_BYTES = 3 * 1024 * 1024 + 123;

function bytesOf(size: number, seed = 1): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed * 7) & 0xff;
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function intakeFor() {
  const state: { items: BackupTransfer[] } = { items: [] };
  const onChange = vi.fn((items: BackupTransfer[]) => {
    state.items = items;
  });
  return { state, onChange, intake: new BackupIntake({ room: ROOM, onChange }) };
}

function messages(ch: FakeChannel, type: string): Record<string, unknown>[] {
  return ch.sent
    .filter((m): m is string => typeof m === 'string')
    .map((m) => JSON.parse(m) as Record<string, unknown>)
    .filter((m) => m.type === type);
}

/** The index of the last chunk fragment this end put on the wire. */
function lastSentIdx(ch: FakeChannel): number {
  for (let i = ch.sent.length - 1; i >= 0; i--) {
    const frame = ch.sent[i]!;
    if (typeof frame !== 'string') continue;
    const header = decodeChunkHeader(frame);
    if (header) return header.idx;
  }
  return -1;
}

const resumeOffset = () =>
  JSON.stringify({ type: 'resume_offset', recordingId: NAME, lastByte: 0, lastIdx: -1 });

/** The host never hears the guest's finalize, as a connection that died mid-send would have it. */
const dropFinalize = (data: unknown, to: 'guest' | 'host') =>
  to === 'host' && typeof data === 'string' && data.includes('recording-finalized');

/** The key the guest minted for this item, so a hello on a later channel can be checked against it. */
function offerKey(ch: FakeChannel): unknown {
  return messages(ch, 'backup_offer')[0]!.key;
}

/**
 * Runs queued microtasks, due timers and the jsdom file reads they started.
 * `setImmediate` stays real so a `Blob` read (which jsdom drives with it)
 * settles; only the poll and the clock are faked.
 */
async function tick(ms = 0): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await vi.advanceTimersByTimeAsync(ms);
    await new Promise((r) => setImmediate(r));
  }
}

/** Guest and host ends wired together, with a real intake on the host end. */
async function offered(size = FILE_BYTES, seed = 1) {
  const bytes = bytesOf(size, seed);
  const file = new File([bytes], NAME);
  const slice = vi.spyOn(file, 'slice');
  const { state, intake } = intakeFor();
  const { guest, host } = fakePair(LABEL);
  intake.offer(host, { peerId: 'p1', name: 'Alice' });
  const shown: BackupTransfer[] = [];
  const send = new BackupSend({ file, onChange: () => shown.push(send.item) });
  send.attach(guest);
  await tick();
  expect(state.items).toHaveLength(1);
  return { bytes, file, slice, state, intake, guest, host, send, shown };
}

/** Hand-drives a guest end until it has sent the whole file, and returns its digest. */
async function sentEverything(guest: FakeChannel, bytes: Uint8Array): Promise<string> {
  const { sha256 } = await framesFor(bytes);
  expect(messages(guest, 'recording-finalized')).toEqual([
    { type: 'recording-finalized', recordingId: NAME, totalBytes: bytes.byteLength, sha256 },
  ]);
  return sha256;
}

describe('BackupSend', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('offers the file and reads nothing until the host agrees', async () => {
    const { slice, state, guest, send } = await offered();

    expect(guest.sent).toHaveLength(1);
    expect(JSON.parse(guest.sent[0] as string)).toMatchObject({
      type: 'backup_offer',
      size: FILE_BYTES,
    });
    expect(state.items[0]!.status).toBe('offered');
    expect(slice).not.toHaveBeenCalled();
    expect(send.settled).toBe(false);
    expect(send.item).toEqual({
      id: NAME,
      kind: 'camera',
      size: FILE_BYTES,
      status: 'offered',
      percent: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(guest.binaryType).toBe('arraybuffer');
    expect(guest.bufferedAmountLowThreshold).toBe(DC_BUFFERED_LOW_WATERMARK);
  });

  it('offers when the channel opens, not before', () => {
    const file = new File([bytesOf(1024)], NAME);
    const guest = fakeChannel(LABEL);
    guest.readyState = 'connecting';
    const send = new BackupSend({ file });
    send.attach(guest);
    expect(guest.sent).toEqual([]);

    guest.readyState = 'open';
    guest.onopen?.();

    expect(JSON.parse(guest.sent[0] as string)).toMatchObject({
      type: 'backup_offer',
      size: 1024,
    });
  });

  it('shows an audio backup as audio and an unreadable name as camera', () => {
    const audio = new BackupSend({
      file: new File([bytesOf(4)], `openmeet-backup-audio-1700000000000-${ROOM}.wav`),
    });
    const older = new BackupSend({ file: new File([bytesOf(4)], 'something.mp4') });

    expect(audio.item).toMatchObject({
      id: `openmeet-backup-audio-1700000000000-${ROOM}.wav`,
      kind: 'audio',
      size: 4,
      status: 'offered',
      percent: 0,
    });
    expect(older.item.kind).toBe('camera');
  });

  it('keeps its state when the channel refuses a send', async () => {
    const file = new File([bytesOf(4)], NAME);
    const guest = fakeChannel(LABEL);
    guest.send = () => {
      throw new Error('send failed');
    };
    const send = new BackupSend({ file });
    send.attach(guest);
    expect(send.item.status).toBe('offered');

    send.cancel();

    expect(await send.done).toBe('failed');
    expect(send.item.status).toBe('failed');
  });

  it('gives one item a key that repeats on a later offer but differs from another item', async () => {
    const file = new File([bytesOf(1024)], NAME);
    const first = fakeChannel(LABEL);
    const send = new BackupSend({ file });
    send.attach(first);
    const second = fakeChannel(LABEL);
    send.attach(second);

    const otherEnd = fakeChannel(`backup#openmeet-backup-1700000000001-${ROOM}.mp4`);
    new BackupSend({ file: new File([bytesOf(1024)], `openmeet-backup-1700000000001-${ROOM}.mp4`) }).attach(
      otherEnd
    );

    const offerOf = (ch: FakeChannel) =>
      JSON.parse(ch.sent[0] as string) as { type: string; size: number; key: unknown };
    const key = offerOf(first).key;
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThan(0);
    expect(offerOf(first).size).toBe(1024);
    expect(offerOf(second).key).toBe(key);
    expect(offerOf(otherEnd).key).not.toBe(key);
  });

  it('writes the whole file on the host and settles saved on a matching verdict', async () => {
    const { bytes, state, intake, guest, send, shown } = await offered();
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);

    expect(await send.done).toBe('saved');
    expect(send.settled).toBe(true);
    expect(send.item).toMatchObject({ status: 'saved', percent: 100 });
    expect(state.items.map((i) => [i.status, i.percent])).toEqual([['saved', 100]]);
    // The verdict is in: this side is done with the channel.
    expect(guest.readyState).toBe('closed');

    const written = folder.files.get(HOST_FILE);
    expect(written?.closed).toBe(true);
    expect(sameBytes(written!.bytes, bytes), 'host file differs from the source').toBe(true);
    expect(folder.files.has(HOST_NOTE)).toBe(true);

    // One render per whole percent point: the last two slices both round to 99,
    // and a caller that re-renders for the second would redraw for nothing.
    expect(shown.map((i) => i.percent)).toEqual([0, 33, 66, 99, 100]);
    expect(shown.map((i) => i.status)).toEqual(['active', 'active', 'active', 'active', 'saved']);
    expect(shown[1]).not.toBe(shown[0]);

    // Calling cancel after saved is a no-op: does not alter item status or emit.
    send.cancel();
    expect(send.item.status).toBe('saved');
    expect(shown).toHaveLength(5);
  });

  it('stops reading while the host end is over the high watermark and resumes on its low event', async () => {
    const { slice, state, intake, guest, send } = await offered();
    guest.bufferedAmount = DC_BUFFERED_HIGH_WATERMARK + 1;
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick();

    const held = slice.mock.calls.length;
    expect(held).toBe(2);
    await tick(1000);
    expect(slice.mock.calls.length).toBe(held);
    expect(send.settled).toBe(false);

    // The crossing itself resumes the queued fragments, before any poll.
    guest.bufferedAmount = 0;
    const queued = guest.sent.length;
    guest.onbufferedamountlow?.();
    expect(guest.sent.length).toBeGreaterThan(queued);
    await tick(1000);

    expect(slice.mock.calls.length).toBeGreaterThan(held);
    expect(await send.done).toBe('saved');
  });

  it('starts one read of the file for a repeated go-ahead', async () => {
    const file = new File([bytesOf(100 * 1024)], NAME);
    const slice = vi.spyOn(file, 'slice');
    const guest = fakeChannel(LABEL);
    const send = new BackupSend({ file });
    send.attach(guest);
    guest.deliver(resumeOffset());
    guest.deliver(resumeOffset());
    await tick();

    expect(slice).toHaveBeenCalledTimes(1);
    expect(messages(guest, 'recording-finalized')).toHaveLength(1);
  });

  it('reads no further than the host has acknowledged', async () => {
    const size = 20 * 1024 * 1024;
    const file = new File([bytesOf(size)], NAME);
    const slice = vi.spyOn(file, 'slice');
    const guest = fakeChannel(LABEL);
    const send = new BackupSend({ file });
    send.attach(guest);
    guest.deliver(resumeOffset());
    await tick(1000);

    // 16 slices fit inside the 16 MiB the host may be holding unwritten; the
    // 17th is sent, and the 18th is read but held back by the wait.
    expect(slice).toHaveBeenCalledTimes(18);
    expect(lastSentIdx(guest)).toBe((17 * BACKUP_READ_BYTES) / (64 * 1024) - 1);
    expect(send.settled).toBe(false);
    expect(messages(guest, 'recording-finalized')).toHaveLength(0);

    guest.deliver(
      JSON.stringify({ type: 'ack', recordingId: 'x', uptoIdx: lastSentIdx(guest), uptoOffset: 0 })
    );
    await tick(1000);

    expect(slice).toHaveBeenCalledTimes(20);
    // Whole file sent, host silent: still active and short of a hundred, so
    // nothing shows as saved before the host's verdict.
    expect(send.item).toEqual({
      id: NAME,
      kind: 'camera',
      size,
      status: 'active',
      percent: 99,
    });
    expect(messages(guest, 'recording-finalized')).toEqual([
      { type: 'recording-finalized', recordingId: NAME, totalBytes: size, sha256: expect.any(String) },
    ]);
  });

  it('recovers when one send throws', async () => {
    const size = 100 * 1024;
    const bytes = bytesOf(size);
    const file = new File([bytes], NAME);
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL);
    const send = new BackupSend({ file });
    const sending: FakeChannel = guest;
    const wire = sending.send.bind(sending);
    let sends = 0;
    let threw = false;
    sending.send = (data: string | ArrayBuffer) => {
      if (++sends === 5) {
        threw = true;
        throw new Error('send failed');
      }
      wire(data);
    };
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    send.attach(guest);
    await tick();
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);

    expect(threw).toBe(true);
    expect(await send.done).toBe('saved');
    expect(sameBytes(folder.files.get(HOST_FILE)!.bytes, bytes), 'host file differs').toBe(true);
  });

  it('fails when the host declines the offer', async () => {
    const { intake, send } = await offered();
    intake.decline();
    await tick(1000);

    expect(await send.done).toBe('failed');
    expect(send.settled).toBe(true);
    expect(send.item).toEqual({
      id: NAME,
      kind: 'camera',
      size: FILE_BYTES,
      status: 'failed',
      percent: 0,
    });
  });

  it('fails a verdict whose byte count is not the file size', async () => {
    const bytes = bytesOf(100 * 1024);
    const file = new File([bytes], NAME);
    const guest = fakeChannel(LABEL);
    const send = new BackupSend({ file });
    send.attach(guest);
    guest.deliver(resumeOffset());
    await tick();
    const sha256 = await sentEverything(guest, bytes);

    guest.deliver(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: NAME,
        totalBytes: bytes.byteLength + 1,
        sha256,
      })
    );
    await tick();

    expect(await send.done).toBe('failed');
    expect(send.item.status).toBe('failed');
  });

  it('fails a verdict whose digest is not a string', async () => {
    const bytes = bytesOf(100 * 1024);
    const file = new File([bytes], NAME);
    const guest = fakeChannel(LABEL);
    const send = new BackupSend({ file });
    send.attach(guest);
    guest.deliver(resumeOffset());
    await tick();
    await sentEverything(guest, bytes);

    guest.deliver(
      JSON.stringify({
        type: 'recording-finalized',
        recordingId: NAME,
        totalBytes: bytes.byteLength,
        sha256: 42,
      })
    );
    await tick();

    expect(await send.done).toBe('failed');
    expect(send.item.status).toBe('failed');
  });

  it('cancels a running send and tells the host to stop', async () => {
    const { slice, state, intake, guest, host, send } = await offered();
    guest.bufferedAmount = DC_BUFFERED_HIGH_WATERMARK + 1;
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick();
    // One slice queued behind the full buffer, one read and held by the wait.
    expect(slice.mock.calls.length).toBe(2);

    send.cancel();
    await tick(1000);

    expect(await send.done).toBe('failed');
    expect(send.settled).toBe(true);
    expect(send.item.status).toBe('failed');
    expect(messages(guest, 'stream-abandoned')).toEqual([
      { type: 'stream-abandoned', recordingId: NAME, lastIdx: expect.any(Number) },
    ]);
    expect(guest.readyState).toBe('closed');
    expect(host.readyState).toBe('closed');
    expect(state.items[0]!.status).toBe('failed');
    // Cancelled is cancelled: the pump stops reading where it stood.
    expect(slice.mock.calls.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    // Calling cancel again is a no-op: does not send another stream-abandoned.
    send.cancel();
    expect(messages(guest, 'stream-abandoned')).toHaveLength(1);
  });

  it('ignores frames and control messages it cannot trust', async () => {
    const size = 100 * 1024;
    const file = new File([bytesOf(size)], NAME);
    const slice = vi.spyOn(file, 'slice');
    const guest = fakeChannel(LABEL);
    const send = new BackupSend({ file });
    send.attach(guest);
    await tick();
    expect(guest.sent).toHaveLength(1);

    guest.deliver(new ArrayBuffer(8));
    guest.deliver('not json at all');
    guest.deliver('null');
    guest.deliver('123');
    guest.deliver('true');
    guest.deliver(JSON.stringify({ type: 'ack', recordingId: NAME, uptoIdx: 'x', uptoOffset: 0 }));
    guest.deliver(
      JSON.stringify({ type: 'resume_offset', recordingId: NAME, lastByte: 0, lastIdx: 1.5 })
    );
    await tick(1000);

    expect(guest.sent).toHaveLength(1);
    expect(slice).not.toHaveBeenCalled();
    expect(send.settled).toBe(false);
    expect(send.item).toEqual({
      id: NAME,
      kind: 'camera',
      size,
      status: 'offered',
      percent: 0,
    });
    expect(vi.getTimerCount()).toBe(0);

    send.cancel();
    await tick();
    expect(guest.readyState).toBe('closed');
    guest.deliver(resumeOffset());
    await tick(1000);

    expect(guest.sent).toHaveLength(2);
    expect(send.item.status).toBe('failed');

    // A channel offered after the end is closed without a word.
    const late = fakeChannel(LABEL);
    send.attach(late);
    expect(late.sent).toEqual([]);
    expect(late.readyState).toBe('closed');
  });

  it('fakePair drop option swallows messages to the targeted role', async () => {
    const { guest, host } = fakePair(LABEL, {
      drop: (_data, to) => to === 'host',
    });
    const guestReceived: unknown[] = [];
    const hostReceived: unknown[] = [];
    guest.onmessage = (ev) => guestReceived.push(ev.data);
    host.onmessage = (ev) => hostReceived.push(ev.data);

    guest.send('from guest');
    host.send('from host');
    await tick();

    expect(hostReceived).toEqual([]);
    expect(guestReceived).toEqual(['from host']);
  });

  it('reads nothing until the send it follows has settled', async () => {
    const bytes = bytesOf(FILE_BYTES);
    const file = new File([bytes], NAME);
    const slice = vi.spyOn(file, 'slice');
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL);
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    let release: () => void = () => {};
    const after = new Promise<void>((r) => (release = r));
    const send = new BackupSend({ file, after });
    send.attach(guest);
    await tick();
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);

    expect(slice).not.toHaveBeenCalled();
    expect(send.item.status).toBe('active');
    expect(send.settled).toBe(false);

    release();
    await tick(1000);

    expect(await send.done).toBe('saved');
    expect(sameBytes(folder.files.get(HOST_FILE)!.bytes, bytes), 'host file differs').toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends anyway when the send it follows has failed', async () => {
    const bytes = bytesOf(100 * 1024);
    const file = new File([bytes], NAME);
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL);
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    let fail: (e: Error) => void = () => {};
    const after = new Promise<void>((_r, reject) => (fail = reject));
    const send = new BackupSend({ file, after });
    send.attach(guest);
    await tick();
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick();

    fail(new Error('the send before this one failed'));
    await tick(1000);

    expect(await send.done).toBe('saved');
    expect(sameBytes(folder.files.get(HOST_FILE)!.bytes, bytes), 'host file differs').toBe(true);
  });

  it('sends nothing while this guest is being recorded', async () => {
    let recording = true;
    const bytes = bytesOf(FILE_BYTES);
    const file = new File([bytes], NAME);
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL);
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    const send = new BackupSend({ file, hold: () => recording });
    send.attach(guest);
    await tick();
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);

    expect(lastSentIdx(guest)).toBe(-1);
    expect(messages(guest, 'recording-finalized')).toHaveLength(0);
    expect(send.settled).toBe(false);

    recording = false;
    await tick(1000);

    expect(await send.done).toBe('saved');
    expect(sameBytes(folder.files.get(HOST_FILE)!.bytes, bytes), 'host file differs').toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resumes at the host position on a replacement channel', async () => {
    const bytes = bytesOf(FILE_BYTES);
    const file = new File([bytes], NAME);
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL);
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    const send = new BackupSend({ file });
    send.attach(guest);
    await tick();
    const key = offerKey(guest);
    guest.bufferedAmount = DC_BUFFERED_HIGH_WATERMARK + 1;
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);
    // Nothing on the wire yet: the whole first slice is queued behind the full buffer.
    expect(lastSentIdx(guest)).toBe(-1);

    // Let the queue out, then fill the buffer again so the drop catches a transfer part-way.
    guest.bufferedAmount = 0;
    guest.onbufferedamountlow?.();
    guest.bufferedAmount = DC_BUFFERED_HIGH_WATERMARK + 1;
    await tick(1000);
    expect(lastSentIdx(guest)).toBe(15);

    host.close();
    await tick(1000);
    expect(send.item.status).toBe('stalled');
    expect(send.settled).toBe(false);
    expect(state.items[0]!.status).toBe('stalled');

    const next = fakePair(LABEL);
    intake.offer(next.host, { peerId: 'p1', name: 'Alice' });
    send.attach(next.guest);

    expect(messages(next.guest, 'resume_query')).toEqual([
      { type: 'resume_query', recordingId: NAME, key },
    ]);

    await tick(1000);

    expect(await send.done).toBe('saved');
    expect(send.item).toMatchObject({ status: 'saved', percent: 100 });
    expect(state.items.map((i) => [i.status, i.percent])).toEqual([['saved', 100]]);
    expect(sameBytes(folder.files.get(HOST_FILE)!.bytes, bytes), 'host file differs').toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends nothing on a replacement channel before the host answers there', async () => {
    const file = new File([bytesOf(FILE_BYTES)], NAME);
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL);
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    const send = new BackupSend({ file });
    send.attach(guest);
    await tick();
    const key = offerKey(guest);
    guest.bufferedAmount = DC_BUFFERED_HIGH_WATERMARK + 1;
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);
    expect(lastSentIdx(guest)).toBe(-1);

    host.close();
    await tick(1000);
    expect(send.item.status).toBe('stalled');

    const next = fakePair(LABEL, { drop: (_data, to) => to === 'guest' });
    intake.offer(next.host, { peerId: 'p1', name: 'Alice' });
    send.attach(next.guest);
    await tick(1000);
    await tick(1000);

    expect(messages(next.guest, 'resume_query')).toEqual([
      { type: 'resume_query', recordingId: NAME, key },
    ]);
    expect(next.guest.sent).toHaveLength(1);
    expect(send.settled).toBe(false);
  });

  it('keeps a freshly read slice off a replacement channel before the host answers there', async () => {
    const bytes = bytesOf(FILE_BYTES);
    const file = new File([bytes], NAME);
    const realSlice = file.slice.bind(file);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    // The third slice lands only when the test says so, which puts the drop
    // between its read and the wait that would hand it to the sender.
    vi.spyOn(file, 'slice').mockImplementation(((at: number, end: number) => {
      const blob = realSlice(at, end);
      if (at !== 2 * BACKUP_READ_BYTES) return blob;
      return {
        arrayBuffer: async () => {
          await held;
          return blob.arrayBuffer();
        },
      } as unknown as Blob;
    }) as typeof file.slice);

    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL);
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    const send = new BackupSend({ file });
    send.attach(guest);
    await tick();
    const key = offerKey(guest);
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);
    // Two slices are on the host's disk; the third is still in the reader.
    expect(folder.files.get(HOST_FILE)!.bytes.byteLength).toBe(2 * BACKUP_READ_BYTES);

    host.close();
    await tick(1000);
    expect(send.item.status).toBe('stalled');

    const next = fakePair(LABEL, { drop: (_data, to) => to === 'guest' });
    intake.offer(next.host, { peerId: 'p1', name: 'Alice' });
    send.attach(next.guest);
    release();
    await tick(1000);

    expect(messages(next.guest, 'resume_query')).toEqual([
      { type: 'resume_query', recordingId: NAME, key },
    ]);
    expect(lastSentIdx(next.guest)).toBe(-1);
    expect(send.settled).toBe(false);
  });

  it('replays the fragments the dead channel never carried', async () => {
    const bytes = bytesOf(100 * 1024);
    const file = new File([bytes], NAME);
    // The old connection carried headers but no payload: the bytes died in flight.
    const lost = (data: unknown, to: 'guest' | 'host') =>
      to === 'host' && (typeof data !== 'string' || data.includes('recording-finalized'));
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL, { drop: lost });
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    const send = new BackupSend({ file });
    send.attach(guest);
    await tick();
    const key = offerKey(guest);
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);
    expect(messages(guest, 'recording-finalized')).toHaveLength(1);
    expect(send.settled).toBe(false);
    expect(folder.files.get(HOST_FILE)!.bytes.byteLength).toBe(0);

    guest.close();
    await tick(1000);
    expect(send.item.status).toBe('stalled');

    const next = fakePair(LABEL);
    intake.offer(next.host, { peerId: 'p1', name: 'Alice' });
    send.attach(next.guest);
    expect(messages(next.guest, 'resume_query')).toEqual([
      { type: 'resume_query', recordingId: NAME, key },
    ]);

    await tick(1000);

    expect(await send.done).toBe('saved');
    expect(sameBytes(folder.files.get(HOST_FILE)!.bytes, bytes), 'host file differs').toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not repeat its finalize on a replacement channel before the host answers there', async () => {
    const bytes = bytesOf(100 * 1024);
    const file = new File([bytes], NAME);
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL, { drop: dropFinalize });
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    const send = new BackupSend({ file });
    send.attach(guest);
    await tick();
    const key = offerKey(guest);
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);
    expect(messages(guest, 'recording-finalized')).toHaveLength(1);
    expect(send.settled).toBe(false);

    host.close();
    await tick(1000);
    expect(send.item.status).toBe('stalled');

    const next = fakePair(LABEL, { drop: (_data, to) => to === 'guest' });
    intake.offer(next.host, { peerId: 'p1', name: 'Alice' });
    send.attach(next.guest);
    await tick(1000);
    await tick(1000);

    expect(messages(next.guest, 'resume_query')).toEqual([
      { type: 'resume_query', recordingId: NAME, key },
    ]);
    expect(next.guest.sent).toHaveLength(1);
    expect(send.settled).toBe(false);
  });

  it('says its finalize again on a replacement channel when the first was lost', async () => {
    const bytes = bytesOf(100 * 1024);
    const file = new File([bytes], NAME);
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL, { drop: dropFinalize });
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    const send = new BackupSend({ file });
    send.attach(guest);
    await tick();
    const key = offerKey(guest);
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);
    expect(messages(guest, 'recording-finalized')).toHaveLength(1);
    expect(send.settled).toBe(false);

    guest.close();
    await tick(1000);
    expect(send.item.status).toBe('stalled');

    const next = fakePair(LABEL);
    intake.offer(next.host, { peerId: 'p1', name: 'Alice' });
    send.attach(next.guest);
    expect(messages(next.guest, 'resume_query')).toEqual([
      { type: 'resume_query', recordingId: NAME, key },
    ]);

    await tick(1000);

    expect(messages(next.guest, 'recording-finalized')).toHaveLength(1);
    expect(await send.done).toBe('saved');
    expect(sameBytes(folder.files.get(HOST_FILE)!.bytes, bytes), 'host file differs').toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('offers again on a replacement channel while the host has not accepted', async () => {
    const { state, intake, guest, host, send } = await offered();
    const key = offerKey(guest);

    host.close();
    await tick();

    const next = fakePair(LABEL);
    intake.offer(next.host, { peerId: 'p1', name: 'Alice' });
    send.attach(next.guest);
    await tick();

    expect(messages(next.guest, 'backup_offer')).toEqual([
      { type: 'backup_offer', size: FILE_BYTES, key },
    ]);
    expect(messages(next.guest, 'resume_query')).toEqual([]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ id: NAME, status: 'offered', size: FILE_BYTES });
  });

  it('fails when the host no longer holds the transfer', async () => {
    const file = new File([bytesOf(FILE_BYTES)], NAME);
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL);
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    const send = new BackupSend({ file });
    send.attach(guest);
    await tick();
    guest.bufferedAmount = DC_BUFFERED_HIGH_WATERMARK + 1;
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);

    host.close();
    await tick(1000);
    expect(send.item.status).toBe('stalled');

    const reloaded = intakeFor();
    const next = fakePair(LABEL);
    reloaded.intake.offer(next.host, { peerId: 'p9', name: 'Alice' });
    send.attach(next.guest);
    await tick(1000);

    expect(send.settled).toBe(true);
    expect(await send.done).toBe('failed');
    expect(send.item.status).toBe('failed');
    expect(messages(next.guest, 'recording-finalized')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a verdict that arrives before the file was sent is not a saved backup', async () => {
    const file = new File([new Uint8Array(3 * BACKUP_READ_BYTES).fill(5)], NAME);
    const send = new BackupSend({ file });
    const ch = fakeChannel(LABEL);
    send.attach(ch);
    // The digest of the empty string, and the size the sender declared: a verdict
    // this side has done nothing to earn.
    ch.deliver(JSON.stringify({
      type: 'recording-finalized', recordingId: NAME, totalBytes: file.size,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    }));
    expect(await send.done).toBe('failed');
    expect(send.item.status).toBe('failed');
  });

  it('ignores a message delivered through a channel that was replaced', async () => {
    const file = new File([bytesOf(FILE_BYTES)], NAME);
    const { state, intake } = intakeFor();
    const { guest, host } = fakePair(LABEL);
    intake.offer(host, { peerId: 'p1', name: 'Alice' });
    const send = new BackupSend({ file });
    send.attach(guest);
    await tick();
    guest.bufferedAmount = DC_BUFFERED_HIGH_WATERMARK + 1;
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    await tick(1000);

    const next = fakePair(LABEL, { drop: (_data, to) => to === 'guest' });
    intake.offer(next.host, { peerId: 'p1', name: 'Alice' });
    send.attach(next.guest);
    await tick(1000);

    // The replaced connection answers late, with the verdict of a file this send never sent.
    guest.deliver(
      JSON.stringify({ type: 'recording-finalized', recordingId: NAME, totalBytes: 1, sha256: 'nope' })
    );
    await tick(1000);

    expect(send.settled).toBe(false);
    expect(send.item.status).toBe('active');
    expect(messages(guest, 'recording-finalized')).toEqual([]);
  });

  it('a replaced channel that drains sends nothing on its replacement before the host answers there', async () => {
    const file = new File([new Uint8Array(BACKUP_READ_BYTES).fill(3)], NAME);
    const send = new BackupSend({ file });
    const first = fakeChannel(LABEL);
    send.attach(first);
    first.bufferedAmount = 17 * 1024 * 1024; // over the high watermark: the megabyte queues
    first.deliver(resumeOffset());
    await tick(300);
    const second = fakeChannel(LABEL);
    send.attach(second);
    first.bufferedAmount = 0;
    first.onbufferedamountlow?.();
    expect(second.sent.map((s) => (typeof s === 'string' ? JSON.parse(s).type : 'bytes'))).toEqual([
      'resume_query',
    ]);
    send.cancel();
  });

  it('a replacement channel that drains before the host answers there sends nothing', async () => {
    const file = new File([new Uint8Array(BACKUP_READ_BYTES).fill(3)], NAME);
    const send = new BackupSend({ file });
    const first = fakeChannel(LABEL);
    send.attach(first);
    first.bufferedAmount = 17 * 1024 * 1024;
    first.deliver(resumeOffset());
    await tick(300);
    const second = fakeChannel(LABEL);
    send.attach(second);
    second.bufferedAmount = 0;
    second.onbufferedamountlow?.();
    expect(second.sent.map((s) => (typeof s === 'string' ? JSON.parse(s).type : 'bytes'))).toEqual([
      'resume_query',
    ]);
    send.cancel();
  });

  it('a replaced channel that drains after the replacement is ready does not drain the queue onto it', async () => {
    const file = new File([new Uint8Array(BACKUP_READ_BYTES).fill(3)], NAME);
    const send = new BackupSend({ file });
    const first = fakeChannel(LABEL);
    send.attach(first);
    first.bufferedAmount = 17 * 1024 * 1024;
    first.deliver(resumeOffset());
    await tick(300);
    const second = fakeChannel(LABEL);
    send.attach(second);
    second.bufferedAmount = 17 * 1024 * 1024;
    second.deliver(resumeOffset());
    await tick(300);
    second.bufferedAmount = 10 * 1024 * 1024;
    first.bufferedAmount = 0;
    first.onbufferedamountlow?.();
    expect(second.sent.map((s) => (typeof s === 'string' ? JSON.parse(s).type : 'bytes'))).toEqual([
      'resume_query',
    ]);
    send.cancel();
  });
});

describe('attachBackupSends', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('points every unsettled send at the connected peer', async () => {
    let connected: () => void = () => {};
    const gate = new Promise<void>((r) => (connected = r));
    const channels: (RTCDataChannel & FakeChannel)[] = [];
    const peer = {
      whenConnected: vi.fn(() => gate),
      createBackupChannel: vi.fn((name: string) => {
        const ch = fakeChannel(`backup#${name}`);
        channels.push(ch);
        return ch as RTCDataChannel;
      }),
    };
    const live = new BackupSend({ file: new File([bytesOf(1024)], NAME) });
    const over = new BackupSend({ file: new File([bytesOf(4)], 'something.mp4') });
    over.cancel();

    const attached = attachBackupSends(peer, [live, over]);
    await tick();
    expect(peer.createBackupChannel).not.toHaveBeenCalled();

    connected();
    await attached;
    await tick();

    expect(peer.whenConnected).toHaveBeenCalledWith(Infinity);
    expect(peer.createBackupChannel).toHaveBeenCalledTimes(1);
    expect(peer.createBackupChannel).toHaveBeenCalledWith(NAME);
    expect(messages(channels[0]!, 'backup_offer')).toEqual([
      { type: 'backup_offer', size: 1024, key: expect.any(String) },
    ]);
    expect(over.settled).toBe(true);
  });
});

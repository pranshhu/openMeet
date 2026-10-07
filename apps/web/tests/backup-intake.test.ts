import { describe, it, expect, vi } from 'vitest';
import {
  BackupIntake,
  MAX_BACKUP_OFFERS_PER_PEER,
  refuseBackup,
  type BackupTransfer,
} from '@/hooks/backup-return';
import { fakeFolder, fakeChannel, flush } from './backup-fakes';

const ROOM = 'abc-defg-hij';
const NO_COPY = JSON.stringify({
  type: 'recording-finalized',
  recordingId: '',
  totalBytes: 0,
  sha256: '',
});

function validLabel(stamp = 1700000000000, room = ROOM, ext = 'mp4', prefix = '') {
  return `backup#openmeet-backup-${prefix}${stamp}-${room}.${ext}`;
}

const offerMsg = (size: unknown, key: unknown = 'test-key') =>
  JSON.stringify({ type: 'backup_offer', size, key });
const FILE = 'backup_alice_camera_20231114T221320000Z.mp4';
const numbered = (n: number) => FILE.replace('.mp4', `_${n}.mp4`);
function setup() {
  const state: { items: BackupTransfer[] } = { items: [] };
  const onChange = vi.fn((next: BackupTransfer[]) => { state.items = next; });
  return { state, onChange, intake: new BackupIntake({ room: ROOM, onChange }) };
}

// Nothing a participant sends may leave an unhandled rejection behind.
async function expectNoRejections(body: () => void): Promise<void> {
  const escaped: unknown[] = [];
  const onRejection = (reason: unknown) => escaped.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    body();
    await flush();
    await flush();
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  expect(escaped).toEqual([]);
}

describe('BackupIntake', () => {
  it('lists a valid offer as offered with id, kind, size and sender name', async () => {
    const { state, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });

    ch.deliver(offerMsg(123456));
    await flush();

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toEqual({
      id: `openmeet-backup-1700000000000-${ROOM}.mp4`,
      kind: 'camera',
      size: 123456,
      status: 'offered',
      percent: 0,
      from: 'Alice',
    });
  });

  it('sanitizes newline from sender name and defaults empty name to Guest', async () => {
    const { state, intake } = setup();

    const ch1 = fakeChannel(validLabel(1700000000001, ROOM, 'mp4'));
    intake.offer(ch1, { peerId: 'peer-1', name: 'Alice\nSmith' });
    ch1.deliver(offerMsg(100));

    const ch2 = fakeChannel(validLabel(1700000000002, ROOM, 'mp4'));
    intake.offer(ch2, { peerId: 'peer-2', name: null });
    ch2.deliver(offerMsg(200));

    const ch3 = fakeChannel(validLabel(1700000000003, ROOM, 'mp4'));
    intake.offer(ch3, { peerId: 'peer-3', name: '   \n  ' });
    ch3.deliver(offerMsg(300));

    await flush();

    expect(state.items).toHaveLength(3);
    expect(state.items[0]!.from).toBe('Alice Smith');
    expect(state.items[1]!.from).toBe('Guest');
    expect(state.items[2]!.from).toBe('Guest');
  });

  it('cuts sender name to 64 code points', async () => {
    const { state, intake } = setup();

    const longName = 'A'.repeat(100);
    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: longName });
    ch.deliver(offerMsg(500));
    await flush();

    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.from).toBe('A'.repeat(64));
  });

  it('refuses a channel for another room on its first message', async () => {
    const { state, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, 'xyz-uvwx-rst', 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Bob' });
    ch.deliver(offerMsg(1000));
    await flush();

    expect(state.items).toHaveLength(0);
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it('refuses a channel whose label is not a backup name', async () => {
    const { state, intake } = setup();

    const ch = fakeChannel('backup#not-a-valid-backup-name');
    intake.offer(ch, { peerId: 'peer-1', name: 'Bob' });
    ch.deliver(offerMsg(1000));
    await flush();

    expect(state.items).toHaveLength(0);
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it("refuses a host's camera backup name", async () => {
    const { state, intake } = setup();

    const ch = fakeChannel(`backup#openmeet-backup-host-1700000000000-${ROOM}.mp4`);
    intake.offer(ch, { peerId: 'peer-1', name: 'Bob' });
    ch.deliver(offerMsg(1000));
    await flush();

    expect(state.items).toHaveLength(0);
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it.each([0, -1, 1.5, '5', 2 ** 53])('refuses invalid size %s', async (badSize) => {
    const { state, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Bob' });
    ch.deliver(offerMsg(badSize));
    await flush();

    expect(state.items).toHaveLength(0);
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it('refuses a ninth waiting offer from one peer while listing another peer first offer', async () => {
    const { state, intake } = setup();

    const peerAChannels = Array.from({ length: MAX_BACKUP_OFFERS_PER_PEER + 1 }, (_, i) =>
      fakeChannel(validLabel(1700000000000 + i, ROOM, 'mp4'))
    );

    for (let i = 0; i < MAX_BACKUP_OFFERS_PER_PEER; i++) {
      intake.offer(peerAChannels[i]!, { peerId: 'peer-a', name: 'Peer A' });
      peerAChannels[i]!.deliver(offerMsg(1000 + i));
    }
    await flush();
    expect(state.items).toHaveLength(8);

    // 9th offer from peer A is refused
    const ch9 = peerAChannels[MAX_BACKUP_OFFERS_PER_PEER]!;
    intake.offer(ch9, { peerId: 'peer-a', name: 'Peer A' });
    ch9.deliver(offerMsg(9999));
    await flush();

    expect(ch9.sent).toEqual([NO_COPY]);
    expect(ch9.readyState).toBe('closed');
    expect(state.items).toHaveLength(8);

    // 1st offer from peer B is accepted and listed
    const chB = fakeChannel(validLabel(1700000099999, ROOM, 'mp4'));
    intake.offer(chB, { peerId: 'peer-b', name: 'Peer B' });
    chB.deliver(offerMsg(2222));
    await flush();

    expect(state.items).toHaveLength(9);
    expect(state.items[8]!.from).toBe('Peer B');
  });

  it('allows new offers from a peer whose previous offers are active and no longer waiting', async () => {
    const { state, intake } = setup();

    const channels = Array.from({ length: MAX_BACKUP_OFFERS_PER_PEER }, (_, i) =>
      fakeChannel(validLabel(1700000000000 + i, ROOM, 'mp4'))
    );
    for (let i = 0; i < MAX_BACKUP_OFFERS_PER_PEER; i++) {
      intake.offer(channels[i]!, { peerId: 'peer-1', name: 'Alice' });
      channels[i]!.deliver(offerMsg(1000 + i));
    }
    await flush();
    expect(state.items).toHaveLength(8);

    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    expect(state.items.every((it) => it.status === 'active')).toBe(true);

    const ch9 = fakeChannel(validLabel(1700000000099, ROOM, 'mp4'));
    intake.offer(ch9, { peerId: 'peer-1', name: 'Alice' });
    ch9.deliver(offerMsg(9999));
    await flush();

    expect(state.items).toHaveLength(9);
    expect(state.items[8]!.status).toBe('offered');
    expect(ch9.readyState).toBe('open');
  });

  it('does nothing when a silent channel arrives with the label of a waiting offer', async () => {
    const { state, intake } = setup();

    const label = validLabel(1700000000000, ROOM, 'mp4');
    const ch1 = fakeChannel(label);
    intake.offer(ch1, { peerId: 'peer-1', name: 'Alice' });
    ch1.deliver(offerMsg(1000));
    await flush();

    expect(state.items).toHaveLength(1);

    const ch2 = fakeChannel(label);
    intake.offer(ch2, { peerId: 'peer-1-reconnect', name: 'Alice Reconnected' });
    await flush();

    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.size).toBe(1000);
    expect(state.items[0]!.from).toBe('Alice');
    expect(ch1.readyState).toBe('open');
    expect(ch2.readyState).toBe('open');
  });

  it('same key, another peerId, first channel still open: the offer moves', async () => {
    const { state, intake } = setup();

    const label = validLabel(1700000000000, ROOM, 'mp4');
    const ch1 = fakeChannel(label);
    intake.offer(ch1, { peerId: 'peer-1', name: 'Alice' });
    ch1.deliver(offerMsg(1000, 'key-1'));
    await flush();

    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.size).toBe(1000);

    const ch2 = fakeChannel(label);
    intake.offer(ch2, { peerId: 'peer-1-reconnect', name: 'Alice New' });
    ch2.deliver(offerMsg(2000, 'key-1'));
    await flush();

    // First channel received NO_COPY and was closed
    expect(ch1.sent).toEqual([NO_COPY]);
    expect(ch1.readyState).toBe('closed');

    // List still has one item with the new size and name
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.size).toBe(2000);
    expect(state.items[0]!.from).toBe('Alice New');

    // Closing ch1 now does not remove the item from the list
    ch1.close();
    await flush();
    expect(state.items).toHaveLength(1);
  });

  it('different key while the holder channel is open, holder WAITING: newcomer is refused and waiting offer untouched', async () => {
    const { state, onChange, intake } = setup();

    const label = validLabel(1700000000000, ROOM, 'mp4');
    const ch1 = fakeChannel(label);
    intake.offer(ch1, { peerId: 'peer-1', name: 'Alice' });
    ch1.deliver(offerMsg(1000, 'key-alice'));
    await flush();

    expect(state.items).toHaveLength(1);
    onChange.mockClear();

    const ch2 = fakeChannel(label);
    intake.offer(ch2, { peerId: 'peer-2', name: 'Mallory' });
    ch2.deliver(offerMsg(2000, 'key-mallory'));
    await flush();

    // Newcomer gets NO_COPY and is closed
    expect(ch2.sent).toEqual([NO_COPY]);
    expect(ch2.readyState).toBe('closed');

    // Holder channel was sent nothing and is open
    expect(ch1.sent).toEqual([]);
    expect(ch1.readyState).toBe('open');

    // Item is unchanged and onChange was not called
    expect(onChange).not.toHaveBeenCalled();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.from).toBe('Alice');
    expect(state.items[0]!.size).toBe(1000);
  });

  it('different key while the holder channel is open, holder ACCEPTED: newcomer is refused and file untouched', async () => {
    const { state, intake } = setup();

    const label = validLabel(1700000000000, ROOM, 'mp4');
    const ch1 = fakeChannel(label);
    intake.offer(ch1, { peerId: 'peer-1', name: 'Alice' });
    ch1.deliver(offerMsg(1000, 'key-alice'));
    await flush();

    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    expect(state.items[0]!.status).toBe('active');
    expect(folder.files.has(FILE)).toBe(true);

    const ch2 = fakeChannel(label);
    intake.offer(ch2, { peerId: 'peer-2', name: 'Mallory' });
    ch2.deliver(offerMsg(2000, 'key-mallory'));
    await flush();

    // Newcomer gets NO_COPY and is closed
    expect(ch2.sent).toEqual([NO_COPY]);
    expect(ch2.readyState).toBe('closed');

    // Holder channel sent only resume_offset, remains open
    expect(ch1.sent).toHaveLength(1);
    expect(ch1.readyState).toBe('open');

    // File is still in folder, nothing removed
    expect(folder.files.has(FILE)).toBe(true);
    expect(folder.removed).toEqual([]);
    expect(state.items[0]!.status).toBe('active');
    expect(state.items[0]!.from).toBe('Alice');
  });

  it('different key after the holder channel closed, on an accepted record: listed as offered again from newcomer', async () => {
    const { state, intake } = setup();

    const label = validLabel(1700000000000, ROOM, 'mp4');
    const ch1 = fakeChannel(label);
    intake.offer(ch1, { peerId: 'peer-1', name: 'Alice' });
    ch1.deliver(offerMsg(1000, 'key-alice'));
    await flush();

    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    expect(state.items[0]!.status).toBe('active');
    expect(folder.files.has(FILE)).toBe(true);

    // Holder channel closes
    ch1.close();
    await flush();

    // Newcomer sends different key after holder closed
    const ch2 = fakeChannel(label);
    intake.offer(ch2, { peerId: 'peer-2', name: 'Bob' });
    ch2.deliver(offerMsg(2000, 'key-bob'));
    await flush();

    // Listed as offered again from newcomer
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.status).toBe('offered');
    expect(state.items[0]!.from).toBe('Bob');
    expect(state.items[0]!.size).toBe(2000);

    // First file was closed and removed
    expect(folder.removed).toEqual([FILE]);
    expect(folder.files.has(FILE)).toBe(false);
  });

  it.each([
    ['missing', JSON.stringify({ type: 'backup_offer', size: 1000 })],
    ['empty', offerMsg(1000, '')],
    ['number', offerMsg(1000, 12345)],
    ['65 chars', offerMsg(1000, 'x'.repeat(65))],
  ])('refuses offer with invalid key: %s', async (_, frame) => {
    const { state, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Bob' });
    ch.deliver(frame);
    await flush();

    expect(state.items).toHaveLength(0);
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it('accepts offer with key of exactly 64 characters', async () => {
    const { state, intake } = setup();

    const key64 = 'k'.repeat(64);
    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Bob' });
    ch.deliver(offerMsg(1000, key64));
    await flush();

    expect(state.items).toHaveLength(1);
    expect(ch.readyState).toBe('open');
    expect(ch.sent).toEqual([]);
  });

  it('accepts offer, opens file in dir, sends resume_offset and marks active', async () => {
    const { state, intake } = setup();

    const label = validLabel(1700000000000, ROOM, 'mp4');
    const ch = fakeChannel(label);
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(1000));
    await flush();

    const folder = fakeFolder();
    await intake.accept(folder, state.items);

    expect(state.items[0]!.status).toBe('active');
    expect(folder.calls).toEqual([
      { name: FILE, create: false },
      { name: FILE, create: true },
    ]);
    expect(folder.files.has(FILE)).toBe(true);

    expect(ch.sent).toHaveLength(1);
    const sent = JSON.parse(ch.sent[0] as string);
    expect(sent).toEqual({
      type: 'resume_offset',
      recordingId: `openmeet-backup-1700000000000-${ROOM}.mp4`,
      lastByte: 0,
      lastIdx: -1,
    });
  });

  it('numbers the file when the folder already holds the name and never creates the first file', async () => {
    const { state, intake } = setup();

    const label = validLabel(1700000000000, ROOM, 'mp4');
    const ch = fakeChannel(label);
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(1000));
    await flush();

    const folder = fakeFolder();
    // Pre-populate the initial file
    folder.files.set(FILE, {
      bytes: new Uint8Array([1, 2, 3]),
      closed: true,
    });

    await intake.accept(folder, state.items);

    expect(folder.calls).toEqual([
      { name: FILE, create: false },
      { name: numbered(2), create: false },
      { name: numbered(2), create: true },
    ]);
    expect(folder.files.has(numbered(2))).toBe(true);
    // Initial file was never created
    const createdFirst = folder.calls.some(
      (c) => c.name === FILE && c.create
    );
    expect(createdFirst).toBe(false);
  });

  it('opens each file once when accept is called twice without waiting', async () => {
    const { state, intake } = setup();

    const label = validLabel(1700000000000, ROOM, 'mp4');
    const ch = fakeChannel(label);
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(1000));
    await flush();

    const folder = fakeFolder();
    const p1 = intake.accept(folder, state.items);
    const p2 = intake.accept(folder, state.items);
    await Promise.all([p1, p2]);

    // Only one file opened with create: true
    const createCalls = folder.calls.filter((c) => c.create);
    expect(createCalls).toHaveLength(1);
  });

  it('opens nothing for a record that a new offer replaced before its turn in accept', async () => {
    const { state, intake } = setup();

    const chA = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    const chB = fakeChannel(validLabel(1700000000001, ROOM, 'mp4'));
    intake.offer(chA, { peerId: 'peer-1', name: 'Alice' });
    intake.offer(chB, { peerId: 'peer-2', name: 'Bob' });
    chA.deliver(offerMsg(100, 'key-a'));
    chB.deliver(offerMsg(200, 'key-b'));
    await flush();

    const folder = fakeFolder();
    const real = folder.getFileHandle.bind(folder);
    folder.getFileHandle = async (name, o) => {
      // While Alice's file is being opened Bob starts over on his channel, so
      // his record is replaced before accept reaches it.
      if (name === FILE && o?.create) chB.deliver(offerMsg(300, 'key-b'));
      return real(name, o);
    };

    await intake.accept(folder, state.items);

    expect(state.items.map((i) => [i.from, i.status])).toEqual([
      ['Alice', 'active'],
      ['Bob', 'offered'],
    ]);
    expect(folder.calls.filter((c) => c.create)).toEqual([{ name: FILE, create: true }]);
    expect(chA.sent).toHaveLength(1);
    expect(chB.sent).toEqual([]);
  });

  it('ends the file of a record that a new offer replaced while it was opening', async () => {
    const { state, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(100, 'key-a'));
    await flush();

    const folder = fakeFolder();
    const real = folder.getFileHandle.bind(folder);
    folder.getFileHandle = async (name, o) => {
      // Alice starts over on her channel while her own file is being opened.
      if (name === FILE && o?.create) ch.deliver(offerMsg(200, 'key-a'));
      return real(name, o);
    };

    await intake.accept(folder, state.items);

    expect(state.items.map((i) => [i.status, i.size])).toEqual([['offered', 200]]);
    expect(folder.files.has(FILE)).toBe(false);
    expect(folder.removed).toEqual([FILE]);
    expect(ch.sent).toEqual([]);
  });

  it('marks item failed, sends NO_COPY, closes channel and resolves when folder refuses create', async () => {
    const { state, intake } = setup();

    const label = validLabel(1700000000000, ROOM, 'mp4');
    const ch = fakeChannel(label);
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(1000));
    await flush();

    const folder = fakeFolder({ refuseCreate: true });
    await expect(intake.accept(folder, state.items)).resolves.toBeUndefined();

    expect(state.items[0]!.status).toBe('failed');
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it('lists fresh offer as offered again when sender starts over on already accepted backup', async () => {
    const { state, intake } = setup();

    const label = validLabel(1700000000000, ROOM, 'mp4');
    const ch1 = fakeChannel(label);
    intake.offer(ch1, { peerId: 'peer-1', name: 'Alice' });
    ch1.deliver(offerMsg(1000));
    await flush();

    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    expect(state.items[0]!.status).toBe('active');
    expect(folder.files.has(FILE)).toBe(true);

    // Sender starts over with a new channel
    const ch2 = fakeChannel(label);
    intake.offer(ch2, { peerId: 'peer-1', name: 'Alice' });
    ch2.deliver(offerMsg(1500));
    await flush();

    // ch1 is told NO_COPY and closed
    expect(ch1.sent).toContain(NO_COPY);
    expect(ch1.readyState).toBe('closed');

    // First file was closed and removed
    expect(folder.removed).toContain(FILE);
    expect(folder.files.has(FILE)).toBe(false);

    // Item is listed as offered again with new size
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.status).toBe('offered');
    expect(state.items[0]!.size).toBe(1500);

    // Nothing new opened until accept is called again
    const createCallsBefore = folder.calls.filter((c) => c.create).length;
    expect(createCallsBefore).toBe(1);

    await intake.accept(folder, state.items);
    expect(state.items[0]!.status).toBe('active');
    const createCallsAfter = folder.calls.filter((c) => c.create).length;
    expect(createCallsAfter).toBe(2);
  });

  it('answers resume_query on a backup channel with NO_COPY', async () => {
    const { intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(JSON.stringify({ type: 'resume_query', recordingId: 'rec' }));
    await flush();

    expect(ch.sent).toEqual([NO_COPY]);
  });

  it('decline answers and closes every waiting offer and empties the list', async () => {
    const { state, onChange, intake } = setup();

    const ch1 = fakeChannel(validLabel(1700000000001, ROOM, 'mp4'));
    const ch2 = fakeChannel(validLabel(1700000000002, ROOM, 'mp4'));
    intake.offer(ch1, { peerId: 'peer-1', name: 'Alice' });
    intake.offer(ch2, { peerId: 'peer-2', name: 'Bob' });
    ch1.deliver(offerMsg(100));
    ch2.deliver(offerMsg(200));
    await flush();

    expect(state.items).toHaveLength(2);
    onChange.mockClear();

    intake.decline();

    expect(onChange).toHaveBeenCalledTimes(1);

    expect(state.items).toHaveLength(0);
    expect(ch1.sent).toEqual([NO_COPY]);
    expect(ch1.readyState).toBe('closed');
    expect(ch2.sent).toEqual([NO_COPY]);
    expect(ch2.readyState).toBe('closed');
  });

  it('removes waiting offer when its channel closes', async () => {
    const { state, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(1000));
    await flush();

    expect(state.items).toHaveLength(1);

    ch.close();
    await flush();

    expect(state.items).toHaveLength(0);
  });

  it('close closes every open writer', async () => {
    const { state, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(1000));
    await flush();

    const folder = fakeFolder();
    await intake.accept(folder, state.items);

    const file = folder.files.get(FILE);
    expect(file?.closed).toBe(false);

    await intake.close();
    expect(file?.closed).toBe(true);
  });

  it('drops chunk frames before accept, non-JSON strings and binary frames without throwing', async () => {
    const { intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });

    await expectNoRejections(() => {
      // Chunk header without "type" key must be skipped without parsing JSON
      const parseSpy = vi.spyOn(JSON, 'parse');
      ch.deliver(JSON.stringify({ idx: 0, offset: 0, size: 100, ts: 0 }));
      expect(parseSpy).not.toHaveBeenCalled();
      parseSpy.mockRestore();

      // Raw binary payload
      ch.deliver(new Uint8Array(100).buffer);

      // Plain text that is not JSON
      ch.deliver('plain text payload');

      // Text frames that mention "type" but are not JSON
      ch.deliver('{"type": oops');
      ch.deliver('{"type":"backup_offer","size":5');

      // Unknown JSON type
      ch.deliver(JSON.stringify({ type: 'unknown_control_msg' }));
    });

    expect(ch.sent).toHaveLength(0);
  });

  it('sets channel binaryType to arraybuffer on offer', () => {
    const { intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });

    expect(ch.binaryType).toBe('arraybuffer');
  });

  it('slices sender name by unicode code points without corrupting multi-byte characters', async () => {
    const { state, intake } = setup();

    // 70 emojis (each is 2 UTF-16 code units, but 1 Unicode code point)
    const emojiName = '🎉'.repeat(70);
    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: emojiName });
    ch.deliver(offerMsg(100));
    await flush();

    expect(state.items).toHaveLength(1);
    expect([...state.items[0]!.from!]).toHaveLength(64);
    expect(state.items[0]!.from).toBe('🎉'.repeat(64));
  });

  it('emits items with new object references on every update and preserves insertion order', async () => {
    const { state, intake } = setup();

    const ch1 = fakeChannel(validLabel(1700000000001, ROOM, 'mp4'));
    const ch2 = fakeChannel(validLabel(1700000000002, ROOM, 'mp4'));
    intake.offer(ch1, { peerId: 'peer-1', name: 'First' });
    intake.offer(ch2, { peerId: 'peer-2', name: 'Second' });

    ch1.deliver(offerMsg(100, 'k1'));
    ch2.deliver(offerMsg(200, 'k2'));
    await flush();

    const batch1 = state.items;
    expect(batch1.map((b) => b.from)).toEqual(['First', 'Second']);
    const item1Before = batch1[0]!;

    // Update item 1 with new size on rebuilt connection
    const ch1Rebuilt = fakeChannel(validLabel(1700000000001, ROOM, 'mp4'));
    intake.offer(ch1Rebuilt, { peerId: 'peer-1', name: 'First Updated' });
    ch1Rebuilt.deliver(offerMsg(300, 'k1'));
    await flush();

    const batch2 = state.items;
    // Insertion order preserved
    expect(batch2.map((b) => b.from)).toEqual(['First Updated', 'Second']);
    const item1After = batch2[0]!;

    // Replaced item is a new object reference (immutable for React state)
    expect(item1After).not.toBe(item1Before);
    expect(item1After.size).toBe(300);
  });

  it('fails record and resolves when folder already has 99 copies of the backup', async () => {
    const { state, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(1000));
    await flush();

    const folder = fakeFolder();
    // Pre-populate original and all copies _2 through _99
    folder.files.set(FILE, { bytes: new Uint8Array(0), closed: true });
    for (let i = 2; i <= 99; i++) {
      folder.files.set(numbered(i), { bytes: new Uint8Array(0), closed: true });
    }

    await expect(intake.accept(folder, state.items)).resolves.toBeUndefined();

    expect(state.items[0]!.status).toBe('failed');
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it('does not delete active record when its channel closes', async () => {
    const { state, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(1000));
    await flush();

    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    expect(state.items[0]!.status).toBe('active');

    // Channel closes while active
    ch.close();
    await flush();

    // Active record remains in the list
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.status).toBe('active');
  });

  it('decline leaves active records intact while clearing offered ones', async () => {
    const { state, intake } = setup();

    const ch1 = fakeChannel(validLabel(1700000000001, ROOM, 'mp4'));
    const ch2 = fakeChannel(validLabel(1700000000002, ROOM, 'mp4'));
    intake.offer(ch1, { peerId: 'peer-1', name: 'Alice' });
    ch1.deliver(offerMsg(100));
    await flush();

    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    expect(state.items[0]!.status).toBe('active');

    intake.offer(ch2, { peerId: 'peer-2', name: 'Bob' });
    ch2.deliver(offerMsg(200));
    await flush();

    expect(state.items).toHaveLength(2);

    intake.decline();

    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.from).toBe('Alice');
    expect(state.items[0]!.status).toBe('active');
    expect(ch2.sent).toEqual([NO_COPY]);
    expect(ch2.readyState).toBe('closed');
  });

  it('refuseBackup helper answers NO_COPY on first message and closes', async () => {
    const ch = fakeChannel('any-label');
    refuseBackup(ch);

    ch.deliver('any-data');
    await flush();

    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it('a start-over closes the writer of the file it drops', async () => {
    const { state, intake } = setup();
    const ch1 = fakeChannel(validLabel(1700000000000));
    intake.offer(ch1, { peerId: 'p1', name: 'Alice' });
    ch1.deliver(offerMsg(1000));
    await flush();
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    const first = folder.files.get(FILE)!;
    expect(first.closed).toBe(false);
    const ch2 = fakeChannel(validLabel(1700000000000));
    intake.offer(ch2, { peerId: 'p1', name: 'Alice' });
    ch2.deliver(offerMsg(1500));
    await flush();
    expect(first.closed).toBe(true);
    expect(folder.removed).toEqual([FILE]);
  });

  it('an offer that moved to another connection counts against that sender', async () => {
    const { state, intake } = setup();
    const moved = fakeChannel(validLabel(1700000000000));
    intake.offer(moved, { peerId: 'p1', name: 'Alice' });
    moved.deliver(offerMsg(10, 'key-shared'));
    for (let i = 1; i < MAX_BACKUP_OFFERS_PER_PEER; i++) {
      const ch = fakeChannel(validLabel(1700000000000 + i));
      intake.offer(ch, { peerId: 'p2', name: 'Alice' });
      ch.deliver(offerMsg(10, `key-p2-${i}`));
    }
    const again = fakeChannel(validLabel(1700000000000));
    intake.offer(again, { peerId: 'p2', name: 'Alice' });
    again.deliver(offerMsg(10, 'key-shared'));
    await flush();
    expect(state.items).toHaveLength(8);
    const ninth = fakeChannel(validLabel(1700000000999));
    intake.offer(ninth, { peerId: 'p2', name: 'Alice' });
    ninth.deliver(offerMsg(10, 'key-ninth'));
    await flush();
    expect(ninth.sent).toEqual([NO_COPY]);
    expect(ninth.readyState).toBe('closed');
    expect(state.items).toHaveLength(8);
  });

  it('the same offer repeated on its own channel keeps the channel and the offer', async () => {
    const { state, intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'p1', name: 'Alice' });
    ch.deliver(offerMsg(1000, 'key-m4'));
    ch.deliver(offerMsg(2000, 'key-m4'));
    await flush();
    expect(ch.readyState).toBe('open');
    expect(ch.sent).toEqual([]);
    // A repeat on the channel that already holds the offer changes nothing,
    // so the size the host read is the one that stays.
    expect(state.items.map((i) => i.size)).toEqual([1000]);
  });

  it('a start-over on the channel that was accepted keeps that channel', async () => {
    const { state, intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'p1', name: 'Alice' });
    ch.deliver(offerMsg(1000, 'key-m5'));
    await flush();
    const folder = fakeFolder();
    await intake.accept(folder, state.items);
    const sentAfterAccept = ch.sent.length;
    ch.deliver(offerMsg(1500, 'key-m5'));
    await flush();
    expect(ch.readyState).toBe('open');
    expect(ch.sent).toHaveLength(sentAfterAccept);
    expect(state.items.map((i) => [i.status, i.size])).toEqual([['offered', 1500]]);
    expect(folder.removed).toEqual([FILE]);
  });

  it('a sender at the limit can still repeat an offer that is already waiting', async () => {
    const { state, intake } = setup();
    const channels = Array.from({ length: MAX_BACKUP_OFFERS_PER_PEER }, (_, i) =>
      fakeChannel(validLabel(1700000000000 + i))
    );
    for (let i = 0; i < channels.length; i++) {
      intake.offer(channels[i]!, { peerId: 'p1', name: 'Alice' });
      channels[i]!.deliver(offerMsg(10, `key-${i}`));
    }
    await flush();
    channels[0]!.deliver(offerMsg(77, 'key-0'));
    await flush();
    expect(channels[0]!.readyState).toBe('open');
    expect(channels[0]!.sent).toEqual([]);
    expect(state.items).toHaveLength(8);
    expect(state.items[0]!.size).toBe(10);
  });

  it('a writer whose close fails does not stop close() or the drop of its file', async () => {
    const { state, intake } = setup();
    const a = fakeChannel(validLabel(1700000000000));
    const b = fakeChannel(validLabel(1700000000001));
    intake.offer(a, { peerId: 'p1', name: 'Alice' });
    intake.offer(b, { peerId: 'p1', name: 'Alice' });
    a.deliver(offerMsg(10, 'key-a'));
    b.deliver(offerMsg(10, 'key-b'));
    await flush();
    const folder = fakeFolder();
    const real = folder.getFileHandle.bind(folder);
    folder.getFileHandle = async (name, o) => {
      const handle = await real(name, o);
      if (name !== FILE) return handle;
      return {
        name,
        createWritable: async () => ({
          write: async () => {},
          close: async () => { throw new Error('commit failed'); },
        }),
      };
    };
    await intake.accept(folder, state.items);
    const second = folder.files.get('backup_alice_camera_20231114T221320001Z.mp4')!;
    const a2 = fakeChannel(validLabel(1700000000000));
    intake.offer(a2, { peerId: 'p1', name: 'Alice' });
    a2.deliver(offerMsg(10, 'key-a'));
    await flush();
    expect(folder.removed).toEqual([FILE]);
    await intake.accept(folder, state.items);
    await expect(intake.close()).resolves.toBeUndefined();
    expect(second.closed).toBe(true);
  });

  it('a refusal waits for the first message, so a channel that is not open yet is still answered', async () => {
    const ch = fakeChannel('backup#openmeet-backup-1700000000000-xyz-uvwx-rst.mp4');
    ch.readyState = 'connecting';
    const { intake } = setup();
    intake.offer(ch, { peerId: 'p1', name: 'Bob' });
    expect(ch.readyState).toBe('connecting');
    expect(ch.sent).toEqual([]);
    ch.readyState = 'open';
    ch.deliver(offerMsg(10));
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it('a text frame that mentions "type" but is not JSON is dropped without a rejection', async () => {
    const { state, intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'p1', name: 'Alice' });

    await expectNoRejections(() => {
      ch.deliver('{"type":');
      ch.deliver('"type" and then nothing');
    });

    expect(ch.sent).toEqual([]);
    expect(ch.readyState).toBe('open');
    expect(state.items).toEqual([]);
  });

  it('does not emit onChange when identical offer is repeated on same channel', async () => {
    const { onChange, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(1000, 'key-1'));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);

    // Identical offer repeated on same channel
    ch.deliver(offerMsg(1000, 'key-1'));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('fails the record when the folder probe fails for a reason other than a missing file', async () => {
    const { state, intake } = setup();

    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.deliver(offerMsg(1000, 'key-1'));
    await flush();

    const folder = fakeFolder();
    folder.files.set(FILE, { bytes: new Uint8Array([1, 2, 3]), closed: true });
    const real = folder.getFileHandle.bind(folder);
    let probes = 0;
    folder.getFileHandle = async (name, o) => {
      // The file is there but the probe fails: that is not "the name is free",
      // so the name must not be reopened for writing.
      if (name === FILE && !o?.create) {
        probes++;
        const err = new Error('Disk error');
        err.name = 'InvalidStateError';
        throw err;
      }
      return real(name, o);
    };

    await expect(intake.accept(folder, state.items)).resolves.toBeUndefined();

    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
    expect(probes).toBe(1);
    expect(folder.calls.some((c) => c.create)).toBe(false);
  });

  it('defaults name made entirely of zero-width or format characters to Guest', async () => {
    const { state, intake } = setup();

    // Zero-width space x10
    const zeroWidthName = '\u200B'.repeat(10);
    const ch = fakeChannel(validLabel(1700000000000, ROOM, 'mp4'));
    intake.offer(ch, { peerId: 'peer-1', name: zeroWidthName });
    ch.deliver(offerMsg(100, 'key-1'));
    await flush();

    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.from).toBe('Guest');
  });

  it('a backup that changed hands is held by the key of the offer that took it', async () => {
    const { state, intake } = setup();
    const alice = fakeChannel(validLabel(1700000000000));
    intake.offer(alice, { peerId: 'p1', name: 'Alice' });
    alice.deliver(offerMsg(1000, 'key-alice'));
    await flush();
    await intake.accept(fakeFolder(), state.items);
    alice.close();

    const bob = fakeChannel(validLabel(1700000000000));
    intake.offer(bob, { peerId: 'p2', name: 'Bob' });
    bob.deliver(offerMsg(2000, 'key-bob'));
    await flush();
    expect(state.items.map((i) => [i.from, i.status])).toEqual([['Bob', 'offered']]);

    // The earlier holder comes back with its own key while Bob's channel is open.
    const back = fakeChannel(validLabel(1700000000000));
    intake.offer(back, { peerId: 'p3', name: 'Alice' });
    back.deliver(offerMsg(1000, 'key-alice'));
    await flush();
    expect(back.sent).toEqual([NO_COPY]);
    expect(back.readyState).toBe('closed');
    expect(bob.sent).toEqual([]);
    expect(bob.readyState).toBe('open');

    bob.deliver(offerMsg(2500, 'key-bob'));
    await flush();
    expect(bob.readyState).toBe('open');
    // The repeat is on the channel that already holds the offer: unchanged.
    expect(state.items.map((i) => [i.from, i.size])).toEqual([['Bob', 2000]]);
  });

  it('a waiting offer that moved to another key is held by that key', async () => {
    const { state, intake } = setup();
    const first = fakeChannel(validLabel(1700000000000));
    intake.offer(first, { peerId: 'p1', name: 'Alice' });
    first.deliver(offerMsg(10, 'key-a'));
    await flush();
    // Closing, and its close event has not fired yet.
    first.readyState = 'closing';

    const second = fakeChannel(validLabel(1700000000000));
    intake.offer(second, { peerId: 'p2', name: 'Bob' });
    second.deliver(offerMsg(20, 'key-b'));
    await flush();
    expect(state.items.map((i) => [i.from, i.size])).toEqual([['Bob', 20]]);

    second.deliver(offerMsg(30, 'key-b'));
    await flush();
    expect(second.sent).toEqual([]);
    expect(second.readyState).toBe('open');
    expect(state.items.map((i) => [i.from, i.size])).toEqual([['Bob', 20]]);
  });

  it('accept with nothing waiting does not call onChange', async () => {
    const { state, onChange, intake } = setup();
    await intake.accept(fakeFolder(), state.items);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not open a numbered name whose probe fails for a reason other than a missing file', async () => {
    const { state, intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'p1', name: 'Alice' });
    ch.deliver(offerMsg(1000, 'key-a'));
    await flush();

    const second = numbered(2);
    const folder = fakeFolder();
    folder.files.set(FILE, { bytes: new Uint8Array([1]), closed: true });
    folder.files.set(second, { bytes: new Uint8Array([2]), closed: true });
    const real = folder.getFileHandle.bind(folder);
    folder.getFileHandle = async (name, o) => {
      if (name === second && !o?.create) {
        const err = new Error('Disk error');
        err.name = 'InvalidStateError';
        throw err;
      }
      return real(name, o);
    };

    await expect(intake.accept(folder, state.items)).resolves.toBeUndefined();
    expect(state.items.map((i) => i.status)).toEqual(['failed']);
    expect(ch.sent).toEqual([NO_COPY]);
    expect(folder.calls.some((c) => c.create)).toBe(false);
  });

  it('lists a name of zero-width characters and spaces as Guest', async () => {
    const { state, intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'p1', name: '\u200B \u200B' });
    ch.deliver(offerMsg(100, 'key-1'));
    await flush();
    expect(state.items.map((i) => i.from)).toEqual(['Guest']);
  });

  it('does not answer a new offer when the replaced record fails to open its file', async () => {
    const { state, intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'p1', name: 'Alice' });
    ch.deliver(offerMsg(100, 'key-a'));
    await flush();

    const folder = fakeFolder({ refuseCreate: true });
    const real = folder.getFileHandle.bind(folder);
    folder.getFileHandle = async (name, o) => {
      // Alice starts over on her channel while the probe for her own file runs.
      if (!o?.create) ch.deliver(offerMsg(200, 'key-a'));
      return real(name, o);
    };

    await intake.accept(folder, state.items);

    expect(state.items.map((i) => [i.status, i.size])).toEqual([['offered', 200]]);
    expect(ch.sent).toEqual([]);
    expect(ch.readyState).toBe('open');
  });

  it('a sender at the limit cannot take over a waiting offer from another connection', async () => {
    const { state, onChange, intake } = setup();
    for (let i = 0; i < MAX_BACKUP_OFFERS_PER_PEER; i++) {
      const ch = fakeChannel(validLabel(1700000000000 + i));
      intake.offer(ch, { peerId: 'p2', name: 'Alice' });
      ch.deliver(offerMsg(10, `key-p2-${i}`));
    }
    const first = fakeChannel(validLabel(1700000000999));
    intake.offer(first, { peerId: 'p1', name: 'Alice' });
    first.deliver(offerMsg(10, 'key-shared'));
    await flush();
    expect(state.items).toHaveLength(9);
    onChange.mockClear();

    const again = fakeChannel(validLabel(1700000000999));
    intake.offer(again, { peerId: 'p2', name: 'Alice' });
    again.deliver(offerMsg(20, 'key-shared'));
    await flush();

    expect(again.sent).toEqual([NO_COPY]);
    expect(again.readyState).toBe('closed');
    expect(first.sent).toEqual([]);
    expect(first.readyState).toBe('open');
    expect(onChange).not.toHaveBeenCalled();
    expect(state.items.at(-1)!.size).toBe(10);
  });

  it('leaves an offer whose size changed after the list was read for the next Save', async () => {
    const { state, intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'p1', name: 'Alice' });
    ch.deliver(offerMsg(1000, 'key-a'));
    await flush();
    const shown = state.items;

    // The sender reconnects and offers the same backup at another size while
    // the list the host read is already on screen.
    const again = fakeChannel(validLabel(1700000000000));
    intake.offer(again, { peerId: 'p1', name: 'Alice' });
    again.deliver(offerMsg(2000, 'key-a'));
    await flush();

    const folder = fakeFolder();
    await intake.accept(folder, shown);

    expect(state.items.map((i) => [i.status, i.size])).toEqual([['offered', 2000]]);
    expect(folder.calls).toEqual([]);
    expect(again.readyState).toBe('open');
  });

  it('leaves an offer that arrived after the list was read for the next Save', async () => {
    const { state, intake } = setup();
    const ch1 = fakeChannel(validLabel(1700000000000));
    intake.offer(ch1, { peerId: 'p1', name: 'Alice' });
    ch1.deliver(offerMsg(1000, 'key-a'));
    await flush();
    const shown = state.items;

    const ch2 = fakeChannel(validLabel(1700000000001));
    intake.offer(ch2, { peerId: 'p2', name: 'Bob' });
    ch2.deliver(offerMsg(2000, 'key-b'));
    await flush();

    const folder = fakeFolder();
    await intake.accept(folder, shown);

    expect(state.items.map((i) => [i.from, i.status])).toEqual([
      ['Alice', 'active'],
      ['Bob', 'offered'],
    ]);
    expect(folder.calls.filter((c) => c.create)).toEqual([{ name: FILE, create: true }]);
    expect(ch2.sent).toEqual([]);
    expect(ch2.readyState).toBe('open');
  });

  it('a Save that lands while a start-over is opening does not remove the new file', async () => {
    const { state, intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'p1', name: 'Alice' });
    ch.deliver(offerMsg(100, 'key-a'));
    await flush();

    const folder = fakeFolder();
    const real = folder.getFileHandle.bind(folder);
    let firstProbe = true;
    let second: Promise<void> | undefined;
    folder.getFileHandle = async (name, o) => {
      // While the first Save is choosing its name, Alice starts over and the
      // host clicks Save again before that file exists.
      if (name === FILE && !o?.create && firstProbe) {
        firstProbe = false;
        ch.deliver(offerMsg(200, 'key-a'));
        second = intake.accept(folder, state.items);
      }
      return real(name, o);
    };

    await intake.accept(folder, state.items);
    await second!;

    expect(state.items.map((i) => [i.status, i.size])).toEqual([['active', 200]]);
    expect(folder.files.has(FILE)).toBe(true);
    // Only the file of the record that was replaced was removed.
    expect(folder.removed).toEqual([FILE]);
    expect(ch.sent).toHaveLength(1);
    expect(JSON.parse(ch.sent[0] as string)).toMatchObject({ type: 'resume_offset', lastIdx: -1 });
  });

  it('removes the file it created when the folder refuses to open it for writing', async () => {
    const { state, intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'p1', name: 'Alice' });
    ch.deliver(offerMsg(1000, 'key-a'));
    await flush();

    const folder = fakeFolder();
    const real = folder.getFileHandle.bind(folder);
    folder.getFileHandle = async (name, o) => {
      const handle = await real(name, o);
      if (name !== FILE) return handle;
      return {
        name,
        createWritable: async () => {
          throw new Error('The disk cannot make the swap file');
        },
      };
    };

    await expect(intake.accept(folder, state.items)).resolves.toBeUndefined();

    expect(state.items.map((i) => i.status)).toEqual(['failed']);
    expect(folder.files.has(FILE)).toBe(false);
    expect(folder.removed).toEqual([FILE]);
    expect(ch.sent).toEqual([NO_COPY]);
    expect(ch.readyState).toBe('closed');
  });

  it('does not attempt to send on a channel whose readyState is not open', async () => {
    const { intake } = setup();
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });
    ch.readyState = 'closed';
    let sendAttempted = false;
    const origSend = ch.send.bind(ch);
    ch.send = (data: any) => {
      sendAttempted = true;
      origSend(data);
    };
    ch.deliver(JSON.stringify({ type: 'resume_query' }));
    await flush();
    expect(sendAttempted).toBe(false);
  });

  it('swallows unhandled rejection when host onChange handler throws', async () => {
    const onChange = vi.fn().mockImplementation(() => {
      throw new Error('Host error during state change');
    });
    const intake = new BackupIntake({ room: ROOM, onChange });
    const ch = fakeChannel(validLabel(1700000000000));
    intake.offer(ch, { peerId: 'peer-1', name: 'Alice' });

    await expectNoRejections(() => {
      ch.deliver(offerMsg(100));
    });
  });
});

import { describe, it, expect } from 'vitest';
import { encodeChunkHeader } from '@openmeet/protocol';
import {
  bindHostGuestChannel,
  bindHostAudioChannel,
  collectGuestReports,
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
    await bindHostGuestChannel(fakeChannel(), h, 'peer-b');
    const second = fakeChannel();
    await bindHostGuestChannel(second, h, 'peer-b'); // reconnect
    await sendChunk(second, 5, 900, 10);

    expect(opened).toEqual(['guest2_rec.mp4']); // opened once, not twice
    // idx/offset continue on the SAME receiver, so a resumed stream doesn't
    // restart at zero and overwrite what's already on disk.
    expect(written).toEqual([{ file: 'guest2_rec.mp4', position: 900, bytes: 10 }]);
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
    await sendChunk(a, 0, 0, 100);

    // Reconnect: a NEW peerId, but the SAME label key.
    const b = fakeChannel('recording#R1');
    await bindHostGuestChannel(b, h, 'peer-b');

    expect(opened).toEqual([]); // slot 0's file was already open; no second file
    expect(h.receiver).toBe(receiver); // same receiver instance, not a fresh one

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

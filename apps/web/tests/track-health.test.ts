import { describe, it, expect, vi } from 'vitest';
import { encodeChunkHeader, MAX_RECORDED_PEERS, type ChunkHeader } from '@openmeet/protocol';
import {
  bindHostGuestChannel,
  bindHostAudioChannel,
  bindHostScreenChannel,
  bindGuestChannel,
  collectTrackHealth,
  MAX_GUEST_TRACK_ROWS,
  type RecordingHandles,
  type HealthPeer,
} from '@/hooks/recording-controller';
import type { ChunkRecorder } from '@/lib/recorder';
import type { PcmRecorder } from '@/lib/pcm-recorder';
import { ChunkSender } from '@/lib/chunk-sender';

type Written = { file: string; position: number; bytes: number };

function fakeDir(opened: string[] = [], written: Written[] = []) {
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

async function sendChunk(
  ch: { deliver(d: string | ArrayBuffer): Promise<void> },
  idx: number,
  offset: number,
  size: number
) {
  await ch.deliver(encodeChunkHeader({ idx, offset, size, ts: 0 }));
  await ch.deliver(new Uint8Array(size).buffer);
}

async function hostHandles(opened: string[] = [], written: Written[] = [], slot0: Written[] = []) {
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

const peer = (peerId: string, name: string | null = null, expected = true): HealthPeer => ({
  peerId,
  name,
  expected,
});

/** A real ChunkSender on a fake channel, fed one chunk per size and optionally acked. */
function makeSender(sizes: number[], opts: { backlogCapBytes?: number } = {}) {
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    sent: [] as (string | ArrayBuffer)[],
    send(data: string | ArrayBuffer) {
      channel.sent.push(data);
    },
  };
  const sender = new ChunkSender({
    recordingId: 'rec',
    channel: channel as unknown as RTCDataChannel,
    ...opts,
  });
  sizes.forEach((size, i) =>
    sender.sendChunk({
      header: { idx: i, offset: i * size, size, ts: 0 } as ChunkHeader,
      payload: new ArrayBuffer(size),
    })
  );
  return { sender, channel };
}

function ack(sender: ChunkSender, uptoIdx: number): void {
  sender.handleControl({ type: 'ack', recordingId: 'rec', uptoIdx, uptoOffset: 0 });
}

describe('collectTrackHealth', () => {
  it('lists own tracks with the recorder byte counts', () => {
    const hostH: RecordingHandles = {
      recordingId: 'rec',
      hostRecorder: { totalBytes: 2048 } as unknown as ChunkRecorder,
      hostPcm: { totalBytes: 96 } as unknown as PcmRecorder,
      screenRecorder: { totalBytes: 5 } as unknown as ChunkRecorder,
      screenSegment: 2,
    };
    expect(collectTrackHealth(hostH, [])).toEqual([
      { key: 'own:camera', track: 'camera', bytes: 2048 },
      { key: 'own:wav', track: 'wav', bytes: 96 },
      { key: 'own:screen:2', track: 'screen', bytes: 5 },
    ]);

    const guestH: RecordingHandles = {
      recordingId: 'rec',
      guestRecorder: { totalBytes: 2048 } as unknown as ChunkRecorder,
      guestPcm: { totalBytes: 96 } as unknown as PcmRecorder,
    };
    expect(collectTrackHealth(guestH, [])).toEqual([
      { key: 'own:camera', track: 'camera', bytes: 2048 },
      { key: 'own:wav', track: 'wav', bytes: 96 },
    ]);
  });

  it('gives no rows when nothing is recording yet', () => {
    expect(collectTrackHealth({ recordingId: 'x' }, [])).toEqual([]);
  });

  it("lists a guest's camera and WAV per slot with what was written", async () => {
    const h = await hostHandles();

    const peerACam = fakeChannel();
    const peerAWav = fakeChannel('recording-audio#peer-a');
    const peerBCam = fakeChannel();

    await bindHostGuestChannel(peerACam, h, 'peer-a');
    await bindHostAudioChannel(peerAWav, h, 'peer-a');
    await bindHostGuestChannel(peerBCam, h, 'peer-b');

    await sendChunk(peerACam, 0, 0, 100);
    await sendChunk(peerAWav, 0, 0, 200);
    await sendChunk(peerBCam, 0, 0, 300);

    const peers = [peer('peer-a', 'Asha'), peer('peer-b', 'Boris')];
    await vi.waitFor(() => {
      expect(collectTrackHealth(h, peers)).toEqual([
        { key: 'g0:mp4', who: 'Asha', track: 'camera', bytes: 100 },
        { key: 'g0:wav', who: 'Asha', track: 'wav', bytes: 200 },
        { key: 'g1:mp4', who: 'Boris', track: 'camera', bytes: 300 },
      ]);
    });
  });

  it('names rows from the roster by current peer with fallback for missing name', async () => {
    const h = await hostHandles();

    const camA = fakeChannel();
    const camB = fakeChannel();
    await bindHostGuestChannel(camA, h, 'peer-a');
    await bindHostGuestChannel(camB, h, 'peer-b');

    const rows = collectTrackHealth(h, [peer('peer-a', 'Asha'), peer('peer-b', null)]);
    expect(rows.find((r) => r.key === 'g0:mp4')?.who).toBe('Asha');
    expect(rows.find((r) => r.key === 'g1:mp4')?.who).toBe('Guest 2');

    const fallback0 = collectTrackHealth(h, [peer('peer-a', null), peer('peer-b', 'Boris')]);
    expect(fallback0.find((r) => r.key === 'g0:mp4')?.who).toBe('Guest');
  });

  it('never leaks the guest-chosen label key into a row', async () => {
    const h = await hostHandles();

    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    const camB = fakeChannel('recording#chosen-by-guest');
    const wavB = fakeChannel('recording-audio#chosen-by-guest');
    await bindHostGuestChannel(camB, h, 'peer-b');
    await bindHostAudioChannel(wavB, h, 'peer-b');

    const rows = collectTrackHealth(h, [peer('peer-a', 'Asha'), peer('peer-b', 'Boris')]);
    expect(JSON.stringify(rows)).not.toContain('chosen-by-guest');
    expect(rows.some((r) => r.key === 'g1:mp4')).toBe(true);
    expect(rows.some((r) => r.key === 'g1:wav')).toBe(true);
  });

  it('drops rows for a guest who is no longer in the room', async () => {
    const h = await hostHandles();

    const camA = fakeChannel();
    const wavA = fakeChannel('recording-audio#peer-a');
    const camB = fakeChannel();

    await bindHostGuestChannel(camA, h, 'peer-a');
    await bindHostAudioChannel(wavA, h, 'peer-a');
    await bindHostGuestChannel(camB, h, 'peer-b');

    await sendChunk(camA, 0, 0, 100);
    await sendChunk(wavA, 0, 0, 200);
    await sendChunk(camB, 0, 0, 300);

    await vi.waitFor(() => {
      const rows = collectTrackHealth(h, [peer('peer-b', 'Boris')]);
      expect(rows.map((r) => r.key)).toEqual(['g1:mp4']);
    });
  });

  it('restores rows under the same key after a guest reconnects', async () => {
    const h = await hostHandles();

    const ch1 = fakeChannel('recording#k1');
    await bindHostGuestChannel(ch1, h, 'peer-a');
    await sendChunk(ch1, 0, 0, 100);

    await vi.waitFor(() => {
      expect(h.receiver?.bytesWritten).toBe(100);
    });

    expect(collectTrackHealth(h, [peer('peer-a2', 'Asha')])).toEqual([
      { key: 'p:peer-a2', who: 'Asha', track: 'camera', bytes: 0 },
    ]);

    const ch2 = fakeChannel('recording#k1');
    await bindHostGuestChannel(ch2, h, 'peer-a2');
    await sendChunk(ch2, 1, 100, 50);

    await vi.waitFor(() => {
      expect(collectTrackHealth(h, [peer('peer-a2', 'Asha')])).toEqual([
        { key: 'g0:mp4', who: 'Asha', track: 'camera', bytes: 150 },
      ]);
    });
  });

  it('lists an expected guest with no channel as zero-byte row until bound', async () => {
    const h = await hostHandles();

    expect(collectTrackHealth(h, [peer('peer-a', 'Asha')])).toEqual([
      { key: 'p:peer-a', who: 'Asha', track: 'camera', bytes: 0 },
    ]);

    const ch = fakeChannel();
    await bindHostGuestChannel(ch, h, 'peer-a');
    const rows = collectTrackHealth(h, [peer('peer-a', 'Asha')]);
    expect(rows.some((r) => r.key === 'g0:mp4')).toBe(true);
    expect(rows.some((r) => r.key === 'p:peer-a')).toBe(false);
  });

  it('does not create zero-byte rows for unexpected peers or handles without dir', async () => {
    const h = await hostHandles();

    expect(collectTrackHealth(h, [peer('peer-a', 'Asha', false)])).toEqual([]);

    const guestH: RecordingHandles = { recordingId: 'rec' };
    expect(collectTrackHealth(guestH, [peer('peer-a', 'Asha', true)])).toEqual([]);
  });

  it("lists a guest's live screen segment and drops it when channel closes", async () => {
    const h = await hostHandles();

    const channel = new EventTarget() as unknown as RTCDataChannel;
    await bindHostScreenChannel(channel, h, undefined, 'peer-a');

    expect(collectTrackHealth(h, [peer('peer-a', 'Asha', false)])).toEqual([
      { key: 's1', who: 'Asha', track: 'screen', bytes: 0 },
    ]);

    expect(collectTrackHealth(h, [])).toEqual([]);

    channel.dispatchEvent(new Event('close'));
    expect(collectTrackHealth(h, [peer('peer-a', 'Asha', false)])).toEqual([]);
    expect(h.screenReceivers?.size).toBe(1);
  });

  it('marks a track whose sender gave up with stopped: true', async () => {
    const h = await hostHandles();

    const camA = fakeChannel();
    const camB = fakeChannel();
    await bindHostGuestChannel(camA, h, 'peer-a');
    await bindHostGuestChannel(camB, h, 'peer-b');

    await camA.deliver(JSON.stringify({ type: 'stream-abandoned', recordingId: 'x', lastIdx: 0 }));

    const rows = collectTrackHealth(h, [peer('peer-a', 'Asha'), peer('peer-b', 'Boris')]);
    const rowA = rows.find((r) => r.key === 'g0:mp4');
    const rowB = rows.find((r) => r.key === 'g1:mp4');

    expect(rowA).toBeDefined();
    expect(rowA?.stopped).toBe(true);
    expect(rowB).toBeDefined();
    expect('stopped' in (rowB ?? {})).toBe(false);
  });

  it('caps rows from channels while own and zero-byte rows survive', async () => {
    const h = await hostHandles();
    h.hostRecorder = { totalBytes: 100 } as unknown as ChunkRecorder;

    for (let i = 0; i < 20; i++) {
      const ch = fakeChannel(`recording#flood-${i}`);
      await bindHostGuestChannel(ch, h, 'peer-0');
    }
    const peers = [peer('peer-0', 'Guest 0'), peer('late', 'Late', true)];

    const rows = collectTrackHealth(h, peers);
    expect(rows[0]?.key).toBe('own:camera');
    expect(rows.filter((r) => r.key.startsWith('g'))).toHaveLength(4);
    expect(rows.some((r) => r.key === 'p:late')).toBe(true);
  });

  it('caps channel rows per source peer so a flooded peer does not push out another guest', async () => {
    const h = await hostHandles();

    for (let i = 0; i < 16; i++) {
      const ch = fakeChannel(`recording#flood-${i}`);
      await bindHostGuestChannel(ch, h, 'peer-flooder');
    }

    const camHonest = fakeChannel('recording#honest');
    const wavHonest = fakeChannel('recording-audio#honest');
    await bindHostGuestChannel(camHonest, h, 'peer-honest');
    await bindHostAudioChannel(wavHonest, h, 'peer-honest');

    await sendChunk(camHonest, 0, 0, 1000);
    await sendChunk(wavHonest, 0, 0, 2000);

    const peers = [peer('peer-flooder', 'Flooder'), peer('peer-honest', 'Honest')];
    await vi.waitFor(() => {
      const rows = collectTrackHealth(h, peers);
      const flooderRows = rows.filter((r) => r.who === 'Flooder');
      const honestRows = rows.filter((r) => r.who === 'Honest');

      expect(flooderRows.length).toBeLessThanOrEqual(4);
      expect(honestRows).toEqual([
        { key: 'g16:mp4', who: 'Honest', track: 'camera', bytes: 1000 },
        { key: 'g16:wav', who: 'Honest', track: 'wav', bytes: 2000 },
      ]);
    });
  });

  it('lists zero-byte camera row alongside wav row for a wav-only expected guest', async () => {
    const h = await hostHandles();
    const wav = fakeChannel('recording-audio#peer-a');
    await bindHostAudioChannel(wav, h, 'peer-a');
    await sendChunk(wav, 0, 0, 200);

    await vi.waitFor(() => {
      const rows = collectTrackHealth(h, [peer('peer-a', 'Asha')]);
      expect(rows).toEqual([
        { key: 'g0:wav', who: 'Asha', track: 'wav', bytes: 200 },
        { key: 'p:peer-a', who: 'Asha', track: 'camera', bytes: 0 },
      ]);
    });
  });

  it('lists zero-byte row for an expected guest whose camera file failed to open', async () => {
    const h = await hostHandles();
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');

    const origGetFileHandle = h.dir!.getFileHandle;
    h.dir!.getFileHandle = async (name: string) => {
      if (name.includes('guest2_rec.mp4')) {
        throw new Error('NotAllowedError');
      }
      return origGetFileHandle(name);
    };

    await expect(bindHostGuestChannel(fakeChannel(), h, 'peer-b')).rejects.toThrow('NotAllowedError');

    const rows = collectTrackHealth(h, [peer('peer-a', 'Asha'), peer('peer-b', 'Boris')]);
    expect(rows).toEqual([
      { key: 'g0:mp4', who: 'Asha', track: 'camera', bytes: 0 },
      { key: 'p:peer-b', who: 'Boris', track: 'camera', bytes: 0 },
    ]);
  });

  it('sorts rows from channels and zero-byte rows together by key', async () => {
    const h = await hostHandles();
    const camA = fakeChannel();
    const camB = fakeChannel();
    const wavA = fakeChannel('recording-audio#peer-a');
    const screen = new EventTarget() as unknown as RTCDataChannel;

    await bindHostGuestChannel(camA, h, 'peer-a');
    await bindHostGuestChannel(camB, h, 'peer-b');
    await bindHostAudioChannel(wavA, h, 'peer-a');
    await bindHostScreenChannel(screen, h, undefined, 'peer-a');

    const rows = collectTrackHealth(h, [peer('peer-a', 'Asha'), peer('peer-b', 'Boris'), peer('late', 'Late')]);
    expect(rows.map((r) => r.key)).toEqual(['g0:mp4', 'g0:wav', 'g1:mp4', 'p:late', 's1']);
  });

  it('caps screen rows per peer', async () => {
    const h = await hostHandles();
    for (let i = 0; i < 20; i++) {
      await bindHostScreenChannel(new EventTarget() as unknown as RTCDataChannel, h, undefined, 'peer-a');
    }
    const rows = collectTrackHealth(h, [peer('peer-a', 'Asha', false)]);
    expect(rows.filter((r) => r.key.startsWith('s'))).toHaveLength(4);
  });

  it("lists slot 0's camera row only once its channel is bound", async () => {
    const h = await hostHandles();
    await bindHostAudioChannel(fakeChannel('recording-audio#peer-a'), h, 'peer-a');
    expect(collectTrackHealth(h, [peer('peer-a', 'Asha', false)]).map((r) => r.key)).toEqual(['g0:wav']);
  });

  it("falls back to 'Guest' for screen rows and zero-byte rows when name is missing", async () => {
    const h = await hostHandles();
    await bindHostScreenChannel(new EventTarget() as unknown as RTCDataChannel, h, undefined, 'peer-a');
    expect(collectTrackHealth(h, [peer('peer-a', null, false), peer('peer-b', null)])).toEqual([
      { key: 'p:peer-b', who: 'Guest', track: 'camera', bytes: 0 },
      { key: 's1', who: 'Guest', track: 'screen', bytes: 0 },
    ]);
  });

  it('counts camera, WAV and screen rows of one peer against the same cap', async () => {
    const h = await hostHandles();
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    await bindHostAudioChannel(fakeChannel('recording-audio#peer-a'), h, 'peer-a');
    for (let i = 0; i < 5; i++) {
      await bindHostScreenChannel(new EventTarget() as unknown as RTCDataChannel, h, undefined, 'peer-a');
    }
    const keys = collectTrackHealth(h, [peer('peer-a', 'Asha')]).map((r) => r.key);
    expect(keys).toEqual(['g0:mp4', 'g0:wav', 's1', 's2']);
  });

  it('keeps the zero-byte row of a guest whose other rows fill its cap', async () => {
    const h = await hostHandles();
    await bindHostGuestChannel(fakeChannel(), h, 'peer-a');
    for (let i = 0; i < 6; i++) {
      await bindHostAudioChannel(fakeChannel(`recording-audio#b${i}`), h, 'peer-b');
    }
    const rows = collectTrackHealth(h, [peer('peer-a', 'Asha'), peer('peer-b', 'Boris')]);
    expect(rows.filter((r) => r.who === 'Boris').map((r) => r.key)).toEqual([
      'g1:wav', 'g2:wav', 'g3:wav', 'g4:wav', 'p:peer-b',
    ]);
  });

  it("counts the cap by peerId, so a flooder using another guest's name leaves that guest alone", async () => {
    const h = await hostHandles();
    for (let i = 0; i < 8; i++) await bindHostGuestChannel(fakeChannel(`recording#flood-${i}`), h, 'peer-m');
    await bindHostGuestChannel(fakeChannel('recording#honest'), h, 'peer-c');
    const rows = collectTrackHealth(h, [peer('peer-m', 'Carol'), peer('peer-c', 'Carol')]);
    expect(rows.map((r) => r.key)).toEqual(['g0:mp4', 'g1:mp4', 'g2:mp4', 'g3:mp4', 'g8:mp4']);
  });

  it("reports what the host has acknowledged of a guest's own camera", () => {
    const { sender } = makeSender([8, 8]);
    ack(sender, 0);

    const h: RecordingHandles = {
      recordingId: 'rec',
      guestRecorder: { totalBytes: 16 } as unknown as ChunkRecorder,
      sender,
    };
    expect(collectTrackHealth(h, [])).toEqual([
      { key: 'own:camera', track: 'camera', bytes: 16, acked: 8 },
    ]);
  });

  it("reads the WAV and screen rows' acknowledgements from their own senders", () => {
    const { sender: camera } = makeSender([8, 8]);
    ack(camera, 0);
    const { sender: wav } = makeSender([8, 8]);
    ack(wav, 1);
    const { sender: screen } = makeSender([8, 8]);

    const h: RecordingHandles = {
      recordingId: 'rec',
      guestRecorder: { totalBytes: 16 } as unknown as ChunkRecorder,
      guestPcm: { totalBytes: 32 } as unknown as PcmRecorder,
      screenRecorder: { totalBytes: 40 } as unknown as ChunkRecorder,
      screenSegment: 3,
      sender: camera,
      wavSender: wav,
      screenSender: screen,
    };
    expect(collectTrackHealth(h, [])).toEqual([
      { key: 'own:camera', track: 'camera', bytes: 16, acked: 8 },
      { key: 'own:wav', track: 'wav', bytes: 32, acked: 16 },
      { key: 'own:screen:3', track: 'screen', bytes: 40, acked: 0 },
    ]);
  });

  it("marks a guest's own row whose sender gave up", () => {
    const { sender } = makeSender([16], { backlogCapBytes: 10 });

    const h: RecordingHandles = {
      recordingId: 'rec',
      guestRecorder: { totalBytes: 16 } as unknown as ChunkRecorder,
      sender,
    };
    expect(collectTrackHealth(h, [])).toEqual([
      { key: 'own:camera', track: 'camera', bytes: 16, acked: 0, stopped: true },
    ]);
  });

  it("leaves the host's own rows without acknowledgement keys", () => {
    const h: RecordingHandles = {
      recordingId: 'rec',
      hostRecorder: { totalBytes: 16 } as unknown as ChunkRecorder,
      hostPcm: { totalBytes: 8 } as unknown as PcmRecorder,
    };
    const rows = collectTrackHealth(h, []);
    expect(rows[0]).not.toHaveProperty('acked');
    expect(rows[0]).not.toHaveProperty('stopped');
    expect(rows[1]).not.toHaveProperty('acked');
    expect(rows[1]).not.toHaveProperty('stopped');
  });

  it('checks an ack as it arrives on the bound channel', () => {
    const channel = {
      readyState: 'open',
      bufferedAmount: 0,
      send() {},
      onmessage: null as ((ev: MessageEvent) => void) | null,
    };
    const sender = new ChunkSender({ recordingId: 'rec', channel: channel as unknown as RTCDataChannel });
    bindGuestChannel(channel as unknown as RTCDataChannel, sender);
    for (let i = 0; i < 2; i++) {
      sender.sendChunk({
        header: { idx: i, offset: i * 8, size: 8, ts: 0 } as ChunkHeader,
        payload: new ArrayBuffer(8),
      });
    }

    channel.onmessage!({ data: '{"type":"ack","uptoIdx":1e999}' } as MessageEvent);
    channel.onmessage!({ data: '{"type":"ack","uptoIdx":"1"}' } as MessageEvent);
    expect(sender.lastAckedIdx).toBe(-1);

    channel.onmessage!({ data: '{"type":"ack","uptoIdx":1}' } as MessageEvent);
    expect(sender.ackedBytes).toBe(16);
  });

  it('exports MAX_GUEST_TRACK_ROWS as the maximum channel rows for a full room', () => {
    expect(MAX_GUEST_TRACK_ROWS).toBe(MAX_RECORDED_PEERS * 4);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { phaseOnFatalClose } from '@/hooks/useRoom';
import { allWriters, bindHostChannel, endHostRecording, endGuestRecording, type RecordingHandles } from '@/hooks/recording-controller';
import { ChunkReceiver } from '@/lib/chunk-receiver';
import { ChunkSender } from '@/lib/chunk-sender';
import { ChunkRecorder, RECORDER_STOP_TIMEOUT_MS } from '@/lib/recorder';
import { wavHeader } from '@/lib/wav';
import { SignalClient } from '@/lib/signal';
import {
  decodeChunkHeader,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_HEARTBEAT_TIMEOUT_MS,
} from '@openmeet/protocol';

/**
 * Regression guards for data-loss bugs. Each of these
 * FAILS on the code as it was: every one of them lost recordings silently,
 * with the UI still reading "Recording".
 */

describe('phaseOnFatalClose — a terminal close must not unmount a live recording', () => {
  // Switching phase unmounts CallStage, which removes "End & save", which is
  // the only thing that closes the file handles.
  it('holds the phase while recording or finalizing', () => {
    expect(phaseOnFatalClose('recording', 4001)).toBeNull();
    expect(phaseOnFatalClose('recording', 4002)).toBeNull();
    expect(phaseOnFatalClose('finalizing', 4003)).toBeNull();
  });

  it('still ends the room when nothing is being recorded', () => {
    expect(phaseOnFatalClose('in-call', 4001)).toMatchObject({ phase: 'full' });
    expect(phaseOnFatalClose('lobby', 4002)).toMatchObject({ phase: 'not-found' });
    expect(phaseOnFatalClose('connecting', 4003)).toMatchObject({ phase: 'not-found' });
  });

  it('handles replaced host close code 4006', () => {
    expect(phaseOnFatalClose('in-call', 4006)).toEqual({ phase: 'replaced' });
    expect(phaseOnFatalClose('recording', 4006)).toBeNull();
  });
});

describe('allWriters — the last-resort commit must close every open file', () => {
  // pagehide and unmount closed hostWriter and guestWriter only, leaving both
  // WAV masters, every screen segment and every guest-2+ file at 0 bytes.
  it('returns all eight writer slots, not just the first two', () => {
    const w = (fileName: string) => ({ fileName, close: vi.fn() }) as never;
    const h: RecordingHandles = {
      recordingId: 'r',
      hostWriter: w('host.mp4'),
      guestWriter: w('guest.mp4'),
      hostWavWriter: w('host.wav'),
      guestWavWriter: w('guest.wav'),
      screenWriters: [w('screen1.mp4'), w('screen2.mp4')],
      extraWriters: [w('guest2.mp4'), w('guest2.wav')],
    };
    expect(allWriters(h).map((x) => x.fileName)).toEqual([
      'host.mp4', 'guest.mp4', 'host.wav', 'guest.wav',
      'screen1.mp4', 'screen2.mp4', 'guest2.mp4', 'guest2.wav',
    ]);
  });

  it('skips slots that were never opened', () => {
    expect(allWriters({ recordingId: 'r' })).toEqual([]);
  });
});

describe('endHostRecording — waits per FILE, not just the camera', () => {
  const writer = () => ({
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fileName: 'f',
  });

  function receiver() {
    return new ChunkReceiver({ recordingId: 'r', writer: writer() as never, sendControl: () => {} });
  }

  // The WAV's real data size is the LAST chunk on the audio channel. The host
  // used to wait only on the camera channel — a different SCTP stream with no
  // ordering guarantee — so it could close a WAV still declaring size 0.
  it('does not close the WAV writer until the audio channel has finalized', async () => {
    const wavRecv = receiver();
    const camRecv = receiver();
    const guestWav = writer();
    const h: RecordingHandles = {
      recordingId: 'r',
      receiver: camRecv,
      channelRef: { current: { readyState: 'open' } as RTCDataChannel },
      guestReceivers: new Map([['p:wav', { receiver: wavRecv, ref: { current: null } }]]),
      guestWavWriter: guestWav as never,
      wavReceiver: wavRecv,
    };

    // Camera finalizes immediately; the WAV has not.
    await camRecv.handleMessage(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'r', totalBytes: 1, sha256: 'a' })
    );

    let closed = false;
    const done = endHostRecording(h).then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed, 'closed the WAV while its channel was still finalizing').toBe(false);

    await wavRecv.handleMessage(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'r', totalBytes: 1, sha256: 'b' })
    );
    await done;
    expect(closed).toBe(true);
    expect(guestWav.close).toHaveBeenCalled();
  }, 20_000);

  // A guest whose first chunk had not landed had bytesWritten === 0, so the old
  // gate skipped the wait entirely — the take that most needed grace got none.
  it('waits even when no bytes have arrived yet', async () => {
    const recv = receiver();
    const h: RecordingHandles = {
      recordingId: 'r',
      receiver: recv,
      channelRef: { current: { readyState: 'open' } as RTCDataChannel },
    };
    let closed = false;
    const done = endHostRecording(h).then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed, 'skipped the wait for a guest with zero bytes written').toBe(false);
    await recv.handleMessage(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'r', totalBytes: 0, sha256: '' })
    );
    await done;
  }, 20_000);

  it('does not wait when no guest channel was ever bound', async () => {
    const h: RecordingHandles = { recordingId: 'r', receiver: receiver(), channelRef: { current: null } };
    await expect(endHostRecording(h)).resolves.toBeDefined();
  });

  it('stops host recorders before a never-finalizing guest wait resolves', async () => {
    vi.useFakeTimers();
    try {
      const recv = receiver();
      const hostRecorder = {
        stopAndFlush: vi.fn().mockResolvedValue(undefined),
      };
      const hostPcm = {
        stopAndFlush: vi.fn().mockResolvedValue(undefined),
      };
      const h: RecordingHandles = {
        recordingId: 'r',
        receiver: recv,
        channelRef: { current: { readyState: 'open' } as RTCDataChannel },
        hostRecorder: hostRecorder as never,
        hostPcm: hostPcm as never,
      };

      let done = false;
      const endPromise = endHostRecording(h).then(() => { done = true; });

      await vi.advanceTimersByTimeAsync(10);
      expect(hostRecorder.stopAndFlush).toHaveBeenCalled();
      expect(hostPcm.stopAndFlush).toHaveBeenCalled();
      expect(done).toBe(false);

      await vi.advanceTimersByTimeAsync(45_000);
      await endPromise;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves receiver wait early when its channel has closed', async () => {
    const recv = receiver();
    const h: RecordingHandles = {
      recordingId: 'r',
      receiver: recv,
      channelRef: { current: { readyState: 'closed' } as RTCDataChannel },
    };
    let done = false;
    const endPromise = endHostRecording(h).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 10));
    await endPromise;
    expect(done).toBe(true);
  });

  it('keeps receiver pending on rebind after an earlier channel closed until finalized on new channel', async () => {
    const recv = receiver();
    function makeChannel() {
      const ch = {
        binaryType: '',
        readyState: 'open',
        onmessage: null as ((ev: MessageEvent) => void) | null,
        onclose: null as ((ev: Event) => void) | null,
        close() {
          ch.readyState = 'closed';
          ch.onclose?.(new Event('close'));
        },
      };
      return ch as unknown as RTCDataChannel & { close(): void };
    }

    const channelA = makeChannel();
    const channelB = makeChannel();

    bindHostChannel(channelA, recv);
    channelA.close();

    bindHostChannel(channelB, recv);

    let finalized = false;
    const finalizePromise = recv.whenFinalized(30_000).then(() => {
      finalized = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(finalized).toBe(false);

    channelB.onmessage?.({
      data: JSON.stringify({
        type: 'recording-finalized',
        recordingId: 'r',
        totalBytes: 1234,
        sha256: 'abc',
      }),
    } as MessageEvent);

    await finalizePromise;
    expect(finalized).toBe(true);
  });
});

describe('ChunkSender — head-of-line ordering', () => {
  /**
   * A channel that reports a buffer between the two watermarks. That window is
   * where the bug lived: not congested enough to queue, so every new chunk was
   * sent directly — overtaking whatever was already waiting.
   */
  function channel(state = 'open') {
    const sent: number[] = [];
    return {
      ch: {
        readyState: state,
        bufferedAmount: 0,
        send(d: unknown) {
          if (typeof d === 'string') sent.push(JSON.parse(d).idx);
        },
      } as unknown as RTCDataChannel,
      sent,
    };
  }
  const chunk = (idx: number) => ({
    header: { idx, offset: idx * 8, size: 8, ts: 0 },
    payload: new Uint8Array(8).buffer,
  });

  // Wire order must equal produced order. Out of order, the receiver's
  // `idx <= lastIdx` dedupe discards the overtaken chunks PERMANENTLY, and
  // positional writes leave a zero-filled hole with nothing thrown.
  it('never lets a new chunk overtake a queued one', async () => {
    const { ch, sent } = channel();
    const s = new ChunkSender({ recordingId: 'r', channel: ch });

    // Congested: this one queues.
    (ch as { bufferedAmount: number }).bufferedAmount = 32 * 1024 * 1024;
    s.sendChunk(chunk(0));
    expect(sent).toEqual([]);

    // Buffer drops between the watermarks — the old code sent this immediately,
    // ahead of chunk 0.
    (ch as { bufferedAmount: number }).bufferedAmount = 12 * 1024 * 1024;
    s.sendChunk(chunk(1));

    (ch as { bufferedAmount: number }).bufferedAmount = 0;
    s.drainQueue();
    expect(sent, 'chunk 1 overtook chunk 0 and the receiver would drop 0').toEqual([0, 1]);
  });

  it('pauses the recorder while the channel is closed, so the queue cannot run away', () => {
    const { ch } = channel('closed');
    const paused: boolean[] = [];
    const s = new ChunkSender({ recordingId: 'r', channel: ch, onBackpressure: (p) => paused.push(p) });
    s.sendChunk(chunk(0));
    expect(paused, 'a closed channel queued without pausing: ~3.4 GB/hr until OOM').toContain(true);
  });
});

describe('ChunkRecorder.stopAndFlush — cannot hang finalize', () => {
  // onstop never arrives from a recorder whose encoder errored or whose track
  // was pulled. Finalize awaits this BEFORE any writer.close(), so a hang means
  // no file is ever closed and the whole take is lost.
  it('resolves via the timeout when onstop never fires', async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const dead = {
        state: 'recording',
        start() {},
        stop() {/* deliberately never fires onstop */},
        ondataavailable: null,
        onstop: null,
        onerror: null,
      };
      const rec = new ChunkRecorder({
        stream: {} as MediaStream,
        mimeType: 'video/mp4',
        mrFactory: () => dead as unknown as MediaRecorder,
        onChunk: () => {},
        onError: (e) => errors.push(e),
      });
      rec.start();
      let settled = false;
      const p = rec.stopAndFlush().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(RECORDER_STOP_TIMEOUT_MS + 100);
      await p;
      expect(settled, 'finalize hung, so no writer was ever closed').toBe(true);
      expect(errors).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('wavHeader — saturates instead of wrapping past 4 GiB', () => {
  const u32 = (b: ArrayBuffer, off: number) => new DataView(b).getUint32(off, true);

  // setUint32 takes the value mod 2^32, so a >4 GiB session declared a wrong
  // SMALL number and every decoder stopped there. Measured: a wrapped header
  // reads 0.244s of a 1.0s file; a clamped one reads the full 1.0s.
  it('clamps rather than wrapping a data size past 2^32', () => {
    const fmt = { sampleRate: 48000, channels: 2, bitDepth: 24 };
    const over = 5_184_000_000; // ~5 hours of 24-bit/48k stereo
    const h = wavHeader(fmt, over);
    expect(u32(h, 40), 'wrapped to a wrong small number').toBe(0xffff_ffff);
    expect(u32(h, 4)).toBe(0xffff_ffff);
  });

  it('leaves ordinary sizes exactly as they are', () => {
    const h = wavHeader({ sampleRate: 44100, channels: 2, bitDepth: 24 }, 2_669_814);
    expect(u32(h, 40)).toBe(2_669_814);
    expect(u32(h, 4)).toBe(2_669_814 + 36);
  });
});

describe('decodeChunkHeader — rejects indices that are not safe integers', () => {
  /**
   * Infinity and NaN cannot reach here: JSON.stringify turns them into `null`,
   * which a `typeof !== 'number'` check rejects.
   *
   * The CONSEQUENCE is reachable though, via a value JSON carries perfectly
   * well. 1e300 is a finite number, passes `typeof === 'number'` and `>= 0`, and
   * would set the receiver's lastIdx to 1e300 — after which its
   * `idx <= lastIdx` dedupe silently discards every remaining chunk for that
   * file, with nothing thrown on either side.
   */
  it('rejects a huge non-safe integer, which JSON does carry', () => {
    for (const field of ['idx', 'offset', 'size'] as const) {
      const h = { idx: 1, offset: 0, size: 8, ts: 0, [field]: 1e300 };
      expect(decodeChunkHeader(JSON.stringify(h)), `${field}=1e300 was accepted`).toBeNull();
    }
  });

  it('rejects a fractional index', () => {
    expect(decodeChunkHeader(JSON.stringify({ idx: 1.5, offset: 0, size: 8, ts: 0 }))).toBeNull();
  });

  // Belt and braces: these serialize to null, so they were already rejected.
  it('rejects Infinity and NaN (which JSON flattens to null anyway)', () => {
    for (const bad of [Infinity, -Infinity, NaN]) {
      expect(decodeChunkHeader(JSON.stringify({ idx: bad, offset: 0, size: 8, ts: 0 }))).toBeNull();
    }
  });

  it('still accepts an ordinary header', () => {
    expect(decodeChunkHeader(JSON.stringify({ idx: 3, offset: 24, size: 8, ts: 5 })))
      .toEqual({ idx: 3, offset: 24, size: 8, ts: 5 });
  });
});

describe('SignalClient — the heartbeat enforces a reply deadline', () => {
  class FakeWs {
    static last: FakeWs | null = null;
    readyState = 1;
    closed = false;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: ((e?: { code?: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { FakeWs.last = this; }
    send(d: string) { this.sent.push(d); }
    close() { this.closed = true; this.readyState = 3; this.onclose?.({ code: 1006 }); }
  }

  // Pings went out but nothing read a reply, and WS_HEARTBEAT_TIMEOUT_MS had
  // zero references. On a half-open socket readyState stayed 1, onclose never
  // fired and reconnect never ran — so recording-stop was never delivered.
  it('closes a socket that stops replying, so reconnect can run', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    try {
      const c = new SignalClient({
        wsBase: 'ws://x', slug: 'aaa-bbbb-ccc', displayName: 'n', userAgent: 'u',
        wsFactory: () => new FakeWs() as never,
      });
      c.connect();
      // Hold THIS socket. Once it closes, reconnect makes a new one and
      // FakeWs.last points at the fresh, healthy replacement.
      const ws = FakeWs.last!;
      ws.onopen!();
      vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS + 10);
      expect(ws.closed, 'closed a healthy socket').toBe(false);

      // Silence past the deadline.
      vi.advanceTimersByTime(WS_HEARTBEAT_TIMEOUT_MS + WS_HEARTBEAT_INTERVAL_MS);
      expect(ws.closed, 'a half-open socket was never detected').toBe(true);
      // And the close must lead somewhere: reconnect opened a replacement.
      expect(FakeWs.last, 'closed without reconnecting').not.toBe(ws);
    } finally {
      vi.useRealTimers();
    }
  });

  it('any inbound frame counts as liveness, not just pong', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    try {
      const c = new SignalClient({
        wsBase: 'ws://x', slug: 'aaa-bbbb-ccc', displayName: 'n', userAgent: 'u',
        wsFactory: () => new FakeWs() as never,
      });
      c.connect();
      const ws = FakeWs.last!;
      ws.onopen!();
      for (let t = 0; t < WS_HEARTBEAT_TIMEOUT_MS * 2; t += WS_HEARTBEAT_INTERVAL_MS) {
        vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
        ws.onmessage!({ data: JSON.stringify({ type: 'presence', micOn: true, camOn: true, screenSharing: false, from: 'host' }) });
      }
      expect(ws.closed, 'tore down a connection that was actively relaying').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('endGuestRecording — never sends finalized while chunks are still queued', () => {
  it('does not send recording-finalized when chunks remain queued', async () => {
    vi.useFakeTimers();
    try {
      const ch = {
        readyState: 'open',
        bufferedAmount: 17 * 1024 * 1024,
        send: vi.fn(),
        addEventListener: vi.fn(),
      } as unknown as RTCDataChannel;

      const sender = new ChunkSender({ recordingId: 'r', channel: ch });
      sender.sendChunk({
        header: { idx: 0, offset: 0, size: 8, ts: 1 },
        payload: new ArrayBuffer(8),
      });

      const h = {
        recordingId: 'r',
        channel: ch,
        sender,
      } as unknown as RecordingHandles;

      const endPromise = endGuestRecording(h);
      await vi.advanceTimersByTimeAsync(35_000);
      await endPromise;

      const sentFinalized = vi.mocked(ch.send).mock.calls.some((call) => {
        const arg = call[0];
        return typeof arg === 'string' && (arg as string).includes('recording-finalized');
      });
      expect(sentFinalized).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('endHostRecording — patches WAV header on incomplete or abandoned take', () => {
  it('patches offset 4 and 40 with correct sizes computed from bytes written', async () => {
    const writes: { offset: number; data: ArrayBuffer | ArrayBufferView }[] = [];
    const guestWavWriter = {
      fileName: 'guest_r.wav',
      write: vi.fn().mockImplementation(async (offset: number, data: ArrayBuffer | ArrayBufferView) => {
        writes.push({ offset, data });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const wavReceiver = new ChunkReceiver({
      recordingId: 'r',
      writer: guestWavWriter as never,
      sendControl: vi.fn(),
    });

    // Write placeholder header (offset 0, 44 bytes)
    await wavReceiver.handleMessage(JSON.stringify({ idx: 0, offset: 0, size: 44, ts: 1 }));
    await wavReceiver.handleMessage(new ArrayBuffer(44));

    // Write audio chunk (offset 44, 960 bytes)
    await wavReceiver.handleMessage(JSON.stringify({ idx: 1, offset: 44, size: 960, ts: 2 }));
    await wavReceiver.handleMessage(new ArrayBuffer(960));

    // Stream was abandoned:
    await wavReceiver.handleMessage(JSON.stringify({ type: 'stream-abandoned', recordingId: 'r', lastIdx: 1 }));

    const h: RecordingHandles = {
      recordingId: 'r',
      guestWavWriter: guestWavWriter as never,
      wavReceiver,
    };

    await endHostRecording(h);

    // Verify offset 4 (RIFF size) and offset 40 (data size) were patched
    const patch4 = writes.find((w) => w.offset === 4);
    const patch40 = writes.find((w) => w.offset === 40);

    expect(patch4).toBeDefined();
    expect(patch40).toBeDefined();

    // 960 data bytes written:
    // data size at offset 40 = 960
    const dataSizeView = new DataView(
      patch40!.data instanceof ArrayBuffer ? patch40!.data : patch40!.data.buffer
    );
    expect(dataSizeView.getUint32(0, true)).toBe(960);

    // riff size at offset 4 = 36 + 960 = 996
    const riffSizeView = new DataView(
      patch4!.data instanceof ArrayBuffer ? patch4!.data : patch4!.data.buffer
    );
    expect(riffSizeView.getUint32(0, true)).toBe(996);
  });
});


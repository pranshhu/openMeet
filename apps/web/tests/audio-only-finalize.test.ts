import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodeChunkHeader } from '@openmeet/protocol';
import {
  startGuestRecording,
  endGuestRecording,
  collectFileChecks,
  type RecordingHandles,
} from '@/hooks/recording-controller';
import { ChunkReceiver } from '@/lib/chunk-receiver';
import { buildSyncReport } from '@/lib/sync-report';

/** The SHA-256 of the three bytes "abc". */
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const finalize = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'recording-finalized', recordingId: 'rec', totalBytes: 0, sha256: 'a', ...extra });

const fakeWriter = (fileName: string) => ({
  fileName,
  size: 10,
  write: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

const receiverFor = (fileName: string) =>
  new ChunkReceiver({ recordingId: 'rec', writer: fakeWriter(fileName) as never, sendControl: () => {} });

describe('a guest recorded with a microphone and no camera', () => {
  afterEach(() => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  });

  it('marks its own handles as audio only, and only then', () => {
    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      ondataavailable: (() => void) | null = null;
      onstop: (() => void) | null = null;
      state = 'inactive';
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
    }
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;

    const mic = { kind: 'audio', getSettings: () => ({}) };
    const cam = { kind: 'video', getSettings: () => ({ frameRate: 30 }) };
    const stream = (audio: unknown[], video: unknown[]) =>
      Object.assign(new EventTarget(), {
        getTracks: () => [...audio, ...video],
        getAudioTracks: () => audio,
        getVideoTracks: () => video,
      }) as unknown as MediaStream;
    const channel = () =>
      ({ readyState: 'open', addEventListener: vi.fn(), send: vi.fn() }) as unknown as RTCDataChannel;

    expect(
      startGuestRecording({ recordingId: 'a', localStream: stream([mic], []), channel: channel() }).audioOnly
    ).toBe(true);
    expect(
      startGuestRecording({ recordingId: 'b', localStream: stream([mic], [cam]), channel: channel() }).audioOnly
    ).toBeUndefined();
    // A stream with nothing in it is not a microphone.
    expect(
      startGuestRecording({ recordingId: 'c', localStream: stream([], []), channel: channel() }).audioOnly
    ).toBeUndefined();
  });

  it('says so in the finish message of its camera channel, and nowhere else', async () => {
    const sender = () => ({
      drain: async () => true,
      digestHex: async () => 'abc',
      isAbandoned: false,
      hasQueuedChunks: false,
      lastAckedIdx: 3,
    });
    const channel = { readyState: 'open', send: vi.fn() };
    const wavChannel = { readyState: 'open', send: vi.fn() };
    const screenChannel = { readyState: 'open', send: vi.fn(), close: vi.fn() };

    await endGuestRecording({
      recordingId: 'r',
      audioOnly: true,
      channel,
      sender: sender(),
      wavChannel,
      wavSender: sender(),
      screenChannel,
      screenSender: sender(),
      screenRecorder: { stopAndFlush: async () => {} },
    } as never);

    expect(JSON.parse(channel.send.mock.calls.at(-1)?.[0])).toMatchObject({
      type: 'recording-finalized',
      audioOnly: true,
    });
    for (const other of [wavChannel, screenChannel]) {
      const sent = JSON.parse(other.send.mock.calls.at(-1)?.[0]);
      expect(sent.type).toBe('recording-finalized');
      expect('audioOnly' in sent).toBe(false);
    }

    const plain = { readyState: 'open', send: vi.fn() };
    await endGuestRecording({ recordingId: 'r', channel: plain, sender: sender() } as never);
    const plainSent = JSON.parse(plain.send.mock.calls.at(-1)?.[0]);
    expect(plainSent.type).toBe('recording-finalized');
    expect('audioOnly' in plainSent).toBe(false);
  });

  it('sends no finish message when its sender gave up, so its file is not named audio only', async () => {
    const gaveUp = {
      drain: async () => true,
      digestHex: async () => 'abc',
      isAbandoned: true,
      hasQueuedChunks: false,
      lastAckedIdx: 3,
    };
    const channel = { readyState: 'open', send: vi.fn() };

    await endGuestRecording({ recordingId: 'r', audioOnly: true, channel, sender: gaveUp } as never);

    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe('the host, told that a guest file has no picture', () => {
  it('takes nothing but true for it, and keeps it once said', async () => {
    const told = receiverFor('guest_rec.mp4');
    expect(told.senderAudioOnly).toBe(false);
    await told.handleMessage(finalize({ audioOnly: true }));
    expect(told.senderAudioOnly).toBe(true);
    await told.handleMessage(finalize());
    expect(told.senderAudioOnly).toBe(true);

    for (const value of ['true', 1, {}, [], null, false]) {
      const r = receiverFor('guest_rec.mp4');
      await r.handleMessage(finalize({ audioOnly: value }));
      expect(r.senderAudioOnly).toBe(false);
    }

    const silent = receiverFor('guest_rec.mp4');
    await silent.handleMessage(finalize());
    expect(silent.senderAudioOnly).toBe(false);
    expect(silent.receivedFinalized).toBe(true);
  });

  it('puts it in that file’s check, and the report names the file as audio only', async () => {
    const guestWriter = fakeWriter('guest_rec.mp4');
    const h: RecordingHandles = {
      recordingId: 'rec',
      take: 1,
      channelRef: { current: null },
      guestWriter: guestWriter as never,
    };
    h.receiver = new ChunkReceiver({ recordingId: 'rec', writer: guestWriter as never, sendControl: () => {} });

    expect((await collectFileChecks(h)).get('guest_rec.mp4')?.audioOnly).toBeUndefined();

    await h.receiver.handleMessage(encodeChunkHeader({ idx: 0, offset: 0, size: 3, ts: 1 }));
    await h.receiver.handleMessage(new Uint8Array([97, 98, 99]).buffer);
    await h.receiver.handleMessage(finalize({ audioOnly: true, sha256: ABC_SHA256 }));
    const checks = await collectFileChecks(h);
    expect(checks.get('guest_rec.mp4')?.audioOnly).toBe(true);

    const guests = [
      {
        slot: 0,
        name: 'Bo',
        file: 'guest_rec.mp4',
        wavFile: 'guest_rec.wav',
        startHostMs: null,
        rttMs: null,
        trackFps: 30,
      },
    ];
    const report = buildSyncReport({ recordingId: 'rec', hostFile: 'host_rec.mp4', hostStartMs: 0, guests, checks });
    const json = JSON.parse(report.json);
    expect(report.data.fileList.find((f) => f.name === 'guest_rec.mp4')).toMatchObject({
      kind: 'audio-only',
      bytes: 10,
      verdict: { text: 'Complete. Matches what Bo sent (SHA-256).' },
    });
    expect(report.data.fileList.find((f) => f.name === 'host_rec.mp4')?.kind).toBe('video');
    expect(json.audioOnly.files).toEqual(['guest_rec.mp4']);
    expect(json.combine.guest).toBeUndefined();
    expect(json.frameRate.files.map((f: { file: string }) => f.file)).not.toContain('guest_rec.mp4');
    expect(report.data.commands.map((c) => c.label)).not.toContain(
      'Bo: pair video with the uncompressed audio master'
    );

    const unflagged = buildSyncReport({
      recordingId: 'rec',
      hostFile: 'host_rec.mp4',
      hostStartMs: 0,
      guests,
      checks: new Map(),
    });
    const unflaggedJson = JSON.parse(unflagged.json);
    expect(unflaggedJson.combine.guest).toBeDefined();
    expect(unflaggedJson.frameRate.files.map((f: { file: string }) => f.file)).toContain('guest_rec.mp4');
  });

  it('reaches only the file whose sender said it', async () => {
    const first = fakeWriter('guest_rec.mp4');
    const second = fakeWriter('guest2_rec.mp4');
    const h: RecordingHandles = {
      recordingId: 'rec',
      take: 1,
      channelRef: { current: null },
      guestWriter: first as never,
      extraWriters: [second as never],
    };
    h.receiver = new ChunkReceiver({ recordingId: 'rec', writer: first as never, sendControl: () => {} });
    const other = new ChunkReceiver({ recordingId: 'rec', writer: second as never, sendControl: () => {} });
    h.guestReceivers = new Map([['peer2:mp4', { receiver: other, ref: { current: null } }]]);

    await h.receiver.handleMessage(finalize({ audioOnly: true }));
    await other.handleMessage(finalize());
    const checks = await collectFileChecks(h);
    expect(checks.get('guest_rec.mp4')?.audioOnly).toBe(true);
    expect(checks.get('guest2_rec.mp4')?.audioOnly).toBeUndefined();
  });

  it('keeps the label on a file continued after a host reload', async () => {
    const guestWriter = fakeWriter('guest_rec.mp4');
    const h: RecordingHandles = {
      recordingId: 'rec',
      take: 1,
      channelRef: { current: null },
      guestWriter: guestWriter as never,
    };
    h.receiver = new ChunkReceiver({
      recordingId: 'rec',
      writer: guestWriter as never,
      sendControl: () => {},
      resumeFrom: { nextIdx: 1, end: 10 },
    });
    await h.receiver.handleMessage(encodeChunkHeader({ idx: 1, offset: 10, size: 3, ts: 1 }));
    await h.receiver.handleMessage(new Uint8Array([97, 98, 99]).buffer);
    await h.receiver.handleMessage(finalize({ audioOnly: true }));
    expect((await collectFileChecks(h)).get('guest_rec.mp4')).toEqual({
      bytes: 10,
      audioOnly: true,
      recovered: true,
    });
  });

  it('takes it from the finish message alone', async () => {
    const r = receiverFor('guest_rec.mp4');
    for (const type of ['resume_query', 'clock_ping', 'recording_meta', 'stream-abandoned', 'ack']) {
      await r.handleMessage(JSON.stringify({ type, audioOnly: true }));
    }
    expect(r.senderAudioOnly).toBe(false);
  });
});

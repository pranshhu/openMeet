import { describe, it, expect, vi } from 'vitest';
import {
  deferGuestStreams,
  startScreenRecording,
  stopScreenRecording,
  type RecordingHandles,
} from '@/hooks/recording-controller';
import { takeBackupFiles } from '@/hooks/backup-return';
import { FakeDirectoryHandle, FullDirectoryHandle } from './fake-opfs';

const ON_DISK = 'openmeet-backup-1700000000000-abc-defg-hij';

/** A guest's take as the controller holds it, with senders that only count. */
function take(dirName: string | null, streams: ('sender' | 'wavSender' | 'screenSender')[]) {
  const senders = Object.fromEntries(streams.map((name) => [name, { defer: vi.fn() }]));
  const h = {
    recordingId: 'rec',
    backup: { dirName },
    wavBackup: { dirName },
    screenBackup: { dirName },
    ...senders,
  } as unknown as RecordingHandles;
  return { h, senders };
}

// MediaRecorder isn't in jsdom; ChunkRecorder only needs it to construct, start and stop.
function installMediaRecorder() {
  class FakeMR {
    state = 'inactive';
    ondataavailable: ((e: unknown) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.onstop?.();
    }
    pause() {}
    resume() {}
  }
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMR;
  (globalThis as { MediaRecorder: { isTypeSupported: (m: string) => boolean } }).MediaRecorder.isTypeSupported =
    () => true;
}

function fakeScreen(): MediaStream {
  const track = { readyState: 'live', getSettings: () => ({ width: 1920, height: 1080 }) };
  return Object.assign(new EventTarget(), {
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    getTracks: () => [track],
  }) as unknown as MediaStream;
}

/** An open screen channel that records what it was sent. */
function screenChannel() {
  const sent: unknown[] = [];
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    addEventListener: () => {},
    send: (d: unknown) => {
      sent.push(d);
    },
    close: vi.fn(),
  } as unknown as RTCDataChannel;
  return { channel, sent };
}

describe('deferGuestStreams', () => {
  it('defers the camera, the WAV and the running screen stream of a take whose backup is on disk', () => {
    const { h, senders } = take(ON_DISK, ['sender', 'wavSender', 'screenSender']);
    expect(deferGuestStreams(h)).toBe(true);
    expect(h.deferred).toBe(true);
    for (const s of Object.values(senders)) expect(s.defer).toHaveBeenCalledTimes(1);
  });

  it('defers a take that has only a camera stream', () => {
    const { h, senders } = take(ON_DISK, ['sender']);
    expect(deferGuestStreams(h)).toBe(true);
    expect(senders.sender!.defer).toHaveBeenCalledTimes(1);
  });

  it('refuses, and leaves every stream alone, when the backup is not kept on disk', () => {
    const { h, senders } = take(null, ['sender', 'wavSender', 'screenSender']);
    expect(deferGuestStreams(h)).toBe(false);
    expect(h.deferred).toBeUndefined();
    for (const s of Object.values(senders)) expect(s.defer).not.toHaveBeenCalled();
  });

  it('keeps streaming the WAV when the WAV’s own backup is not kept on disk', () => {
    const { h, senders } = take(ON_DISK, ['sender', 'wavSender', 'screenSender']);
    (h as unknown as { wavBackup: { dirName: string | null } }).wavBackup = { dirName: null };
    expect(deferGuestStreams(h)).toBe(true);
    expect(senders.sender!.defer).toHaveBeenCalledTimes(1);
    expect(senders.screenSender!.defer).toHaveBeenCalledTimes(1);
    expect(senders.wavSender!.defer).not.toHaveBeenCalled();
  });

  it('keeps streaming the running screen share when its own backup is not kept on disk', () => {
    const { h, senders } = take(ON_DISK, ['sender', 'wavSender', 'screenSender']);
    (h as unknown as { screenBackup: { dirName: string | null } }).screenBackup = { dirName: null };
    expect(deferGuestStreams(h)).toBe(true);
    expect(senders.sender!.defer).toHaveBeenCalledTimes(1);
    expect(senders.wavSender!.defer).toHaveBeenCalledTimes(1);
    expect(senders.screenSender!.defer).not.toHaveBeenCalled();
  });
});

describe('a screen share that starts during a take', () => {
  it('is not streamed either when the take is being sent afterwards', async () => {
    installMediaRecorder();
    const { channel, sent } = screenChannel();
    const h: RecordingHandles = { recordingId: 'rec-later', deferred: true };

    const root = new FakeDirectoryHandle();
    Object.defineProperty(globalThis.navigator, 'storage', {
      configurable: true,
      value: { getDirectory: async () => root },
    });
    try {
      await startScreenRecording(h, fakeScreen(), 'guest', { createRecordingScreenChannel: () => channel });
      await h.screenBackup!.whenOpen();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.screenBackup!.dirName).not.toBeNull();
      expect(h.screenRecorder).toBeDefined();
      expect(h.screenBackup).toBeDefined();
      expect(h.screenSender?.isAbandoned).toBe(true);
      expect(sent.map((m) => JSON.parse(m as string))).toEqual([
        { type: 'stream-abandoned', recordingId: 'rec-later', lastIdx: -1 },
      ]);
      await stopScreenRecording(h);
    } finally {
      delete (globalThis.navigator as { storage?: unknown }).storage;
    }
  });

  it('is streamed when the take is', async () => {
    installMediaRecorder();
    const { channel, sent } = screenChannel();
    const h: RecordingHandles = { recordingId: 'rec-live' };

    await startScreenRecording(h, fakeScreen(), 'guest', { createRecordingScreenChannel: () => channel });
    expect(h.screenSender?.isAbandoned).toBe(false);
    expect(sent).toEqual([]);
    await stopScreenRecording(h);
  });

  it('is streamed when the take is being sent afterwards and the share’s backup is not kept on disk', async () => {
    installMediaRecorder();
    const { channel, sent } = screenChannel();
    const h: RecordingHandles = { recordingId: 'rec-memory', deferred: true };

    await startScreenRecording(h, fakeScreen(), 'guest', { createRecordingScreenChannel: () => channel });
    await h.screenBackup!.whenOpen();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.screenBackup!.dirName).toBeNull();
    expect(h.screenSender?.isAbandoned).toBe(false);
    expect(sent).toEqual([]);
    await stopScreenRecording(h);
  });

  it('is streamed when the take is, also when the share’s backup is kept on disk', async () => {
    installMediaRecorder();
    const { channel, sent } = screenChannel();
    const h: RecordingHandles = { recordingId: 'rec-live-disk' };

    const root = new FakeDirectoryHandle();
    Object.defineProperty(globalThis.navigator, 'storage', {
      configurable: true,
      value: { getDirectory: async () => root },
    });
    try {
      await startScreenRecording(h, fakeScreen(), 'guest', { createRecordingScreenChannel: () => channel });
      await h.screenBackup!.whenOpen();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.screenBackup!.dirName).not.toBeNull();
      expect(h.screenSender?.isAbandoned).toBe(false);
      expect(sent).toEqual([]);
      await stopScreenRecording(h);
    } finally {
      delete (globalThis.navigator as { storage?: unknown }).storage;
    }
  });

  it('is offered after a take sent afterwards when storage opened its directory and took no chunk', async () => {
    installMediaRecorder();
    const { channel } = screenChannel();
    const h: RecordingHandles = { recordingId: 'rec-full', deferred: true, room: 'abc-defg-hij' };

    const root = new FullDirectoryHandle();
    Object.defineProperty(globalThis.navigator, 'storage', {
      configurable: true,
      value: { getDirectory: async () => root },
    });
    try {
      await startScreenRecording(h, fakeScreen(), 'guest', { createRecordingScreenChannel: () => channel });
      await h.screenBackup!.whenOpen();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.screenSender?.isAbandoned).toBe(true);
      // What the stretch's recorder hands its backup for each chunk.
      h.screenBackup!.writeChunk(new Uint8Array(1000).buffer);
      await stopScreenRecording(h);

      const files = await takeBackupFiles(null, null, h.screenBackups);
      expect(files).toHaveLength(1);
      expect(files[0]!.size).toBe(1000);
      expect(files[0]!.name).toMatch(/^openmeet-backup-screen-\d{13}-abc-defg-hij\.mp4$/);
    } finally {
      delete (globalThis.navigator as { storage?: unknown }).storage;
    }
  });
});

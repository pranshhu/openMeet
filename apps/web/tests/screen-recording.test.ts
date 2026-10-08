import { describe, it, expect, vi } from 'vitest';
import {
  bindHostScreenChannel,
  collectScreenSegments,
  collectTrackHealth,
  collectFileChecks,
  resumeHostRecording,
  startScreenRecording,
  stopScreenRecording,
  type HealthPeer,
  type RecordingHandles,
} from '@/hooks/recording-controller';
import { fileVerdict } from '@/lib/sync-report';
import { findTakeJournals, openTakeJournal, type TakeJournal, type TakeNotes } from '@/lib/take-journal';
import { FakeDirectoryHandle } from './fake-opfs';

/**
 * Screen share was rendered but never recorded: share a deck for twenty minutes
 * and nothing survived the session. These cover the file bookkeeping — one file
 * per share stretch, so repeated toggles don't overwrite each other.
 */

const files: string[] = [];
function fakeDir() {
  return {
    getFileHandle: async (name: string) => {
      files.push(name);
      return {
        name,
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      };
    },
  } as unknown as NonNullable<RecordingHandles['dir']>;
}

function fakeScreen(trackOverrides?: Record<string, unknown>): MediaStream {
  const track = {
    readyState: 'live',
    getSettings: () => ({ width: 2560, height: 1440 }),
    stop() { this.readyState = 'ended'; },
    ...trackOverrides,
  };
  return {
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

/** A TakeJournal whose file() calls are recorded, so a test can tell a receiver really got its journal file. */
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
  const names: string[] = [];
  const journal = {
    notes,
    note: (change: (n: TakeNotes) => void) => change(notes),
    file: (name: string) => {
      names.push(name);
      return { append: () => {}, commit: async () => {}, dead: false };
    },
  } as unknown as TakeJournal;
  return { journal, names };
}

// MediaRecorder isn't in jsdom; ChunkRecorder only needs it to construct/start.
function installMediaRecorder() {
  class FakeMR {
    state = 'inactive';
    ondataavailable: ((e: unknown) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
    pause() {}
    resume() {}
  }
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMR;
  (globalThis as { MediaRecorder: { isTypeSupported: (m: string) => boolean } }).MediaRecorder.isTypeSupported =
    () => true;
}

describe('screen recording', () => {
  it('opens one file per share stretch, numbered so repeats do not collide', async () => {
    installMediaRecorder();
    files.length = 0;
    const h: RecordingHandles = { recordingId: 'rec1', dir: fakeDir() };

    await startScreenRecording(h, fakeScreen(), 'host', null);
    await stopScreenRecording(h);
    await startScreenRecording(h, fakeScreen(), 'host', null);
    await stopScreenRecording(h);

    expect(files).toEqual(['host_screen_rec1.mp4', 'host_screen_rec1_2.mp4']);
    expect(h.screenSegment).toBe(2);
  });

  it('ignores a second start while one is already running', async () => {
    installMediaRecorder();
    files.length = 0;
    const h: RecordingHandles = { recordingId: 'rec2', dir: fakeDir() };
    await startScreenRecording(h, fakeScreen(), 'host', null);
    await startScreenRecording(h, fakeScreen(), 'host', null);
    expect(files).toHaveLength(1);
  });

  it('stop is a no-op when nothing is recording', async () => {
    const h: RecordingHandles = { recordingId: 'rec3' };
    await expect(stopScreenRecording(h)).resolves.toBeUndefined();
  });

  it('creates and starts a screen backup on the sharer, and stops it on stopScreenRecording', async () => {
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'rec-backup', dir: fakeDir() };
    await startScreenRecording(h, fakeScreen(), 'host', null);
    expect(h.screenBackup).toBeDefined();
    const backup = h.screenBackup;
    const stopSpy = vi.spyOn(backup!, 'stop');

    await stopScreenRecording(h);
    expect(stopSpy).toHaveBeenCalled();
    expect(h.screenBackup).toBeUndefined();
  });

  it('records each stretch start time for the sync sidecar', async () => {
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'rec4', dir: fakeDir() };
    await startScreenRecording(h, fakeScreen(), 'host', null);
    await stopScreenRecording(h);
    await startScreenRecording(h, fakeScreen(), 'host', null);
    expect([...(h.screenStartsByFile?.keys() ?? [])]).toEqual(['host_screen_rec4.mp4', 'host_screen_rec4_2.mp4']);
  });

  it('does nothing when the host has no chosen directory', async () => {
    installMediaRecorder();
    files.length = 0;
    const h: RecordingHandles = { recordingId: 'rec5' }; // host not recording yet
    await startScreenRecording(h, fakeScreen(), 'host', null);
    expect(files).toHaveLength(0);
  });

  it('a stop landing during startScreenRecording await leaves screenRecorder unset and the next start records', async () => {
    installMediaRecorder();
    files.length = 0;
    const h: RecordingHandles = { recordingId: 'rec-race', dir: fakeDir() };
    const screen1 = fakeScreen();
    const track1 = screen1.getVideoTracks()[0] as { readyState: string; stop: () => void };

    const origDir = h.dir!;
    h.dir = {
      ...origDir,
      getFileHandle: async (name: string) => {
        track1.stop();
        return origDir.getFileHandle(name);
      },
    } as unknown as NonNullable<RecordingHandles['dir']>;

    await startScreenRecording(h, screen1, 'host', null);

    expect(h.screenRecorder).toBeUndefined();
    expect(h.screenSegment).toBeUndefined();
    expect(h.screenStartsByFile).toBeUndefined();

    // Next start records normally
    h.dir = origDir;
    const screen2 = fakeScreen();
    await startScreenRecording(h, screen2, 'host', null);

    expect(h.screenRecorder).toBeDefined();
    expect(h.screenSegment).toBe(1);
    await stopScreenRecording(h);
  });

  it('a start with no active take is a no-op (leaves screenRecorder unset and does not increment segment)', async () => {
    installMediaRecorder();
    const hHost: RecordingHandles = { recordingId: 'no-take-host' };
    await startScreenRecording(hHost, fakeScreen(), 'host', null);
    expect(hHost.screenRecorder).toBeUndefined();
    expect(hHost.screenSegment).toBeUndefined();
    expect(hHost.screenStartsByFile).toBeUndefined();

    const hGuest: RecordingHandles = { recordingId: 'no-take-guest' };
    await startScreenRecording(hGuest, fakeScreen(), 'guest', null);
    expect(hGuest.screenRecorder).toBeUndefined();
    expect(hGuest.screenSegment).toBeUndefined();
    expect(hGuest.screenStartsByFile).toBeUndefined();
  });

  it('a stop landing during guest channel open await leaves screenRecorder unset and rolls back', async () => {
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'rec-guest' };
    const screen = fakeScreen();
    const track = screen.getVideoTracks()[0] as { readyState: string; stop: () => void };

    let channelOpenListener: (() => void) | undefined;
    const fakeChannel = {
      readyState: 'connecting',
      addEventListener: (_event: string, cb: () => void) => {
        channelOpenListener = cb;
      },
      close: vi.fn(),
    } as unknown as RTCDataChannel;

    const fakePeer = {
      createRecordingScreenChannel: () => fakeChannel,
    };

    const startPromise = startScreenRecording(h, screen, 'guest', fakePeer);

    track.stop();
    channelOpenListener?.();
    await startPromise;

    expect(h.screenRecorder).toBeUndefined();
    expect(h.screenSegment).toBeUndefined();
    expect(fakeChannel.close).toHaveBeenCalled();
  });

  it('start error leaves screenRecorder unset, closes writer, and notifies onError', async () => {
    installMediaRecorder();
    const origMR = (globalThis as unknown as { MediaRecorder: { prototype: { start: () => void } } }).MediaRecorder;
    const origStart = origMR.prototype.start;
    origMR.prototype.start = () => {
      throw new Error('MediaRecorder start failed');
    };

    const h: RecordingHandles = { recordingId: 'rec-err', dir: fakeDir() };
    const screen = fakeScreen();
    const onError = vi.fn();

    await startScreenRecording(h, screen, 'host', null, onError);

    expect(h.screenRecorder).toBeUndefined();
    expect(h.screenSegment).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    origMR.prototype.start = origStart;
  });

  it('host drops the empty file of a guest share stopped before its first chunk', async () => {
    const removed: string[] = [];
    const dir = { ...fakeDir(), removeEntry: async (n: string) => { removed.push(n); } };
    const h = { recordingId: 'r1', dir } as unknown as RecordingHandles;
    const channel = new EventTarget() as unknown as RTCDataChannel;
    await bindHostScreenChannel(channel, h);
    expect(h.screenWriters).toHaveLength(1);

    channel.dispatchEvent(new Event('close'));
    await vi.waitFor(() => expect(removed).toEqual(['guest_screen_r1.mp4']));
    expect(h.screenWriters).toEqual([]);
  });

  // Host and guest segments are registered at different moments, so pairing
  // start times with files by position gave a segment another one's offset.
  it('pairs each screen file with its own start when host and guest segments interleave', async () => {
    installMediaRecorder();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const base = fakeDir();
      const dir = {
        getFileHandle: async (name: string) => {
          if (name.startsWith('host_')) await gate; // host file opens slowly
          return base.getFileHandle(name);
        },
      } as unknown as NonNullable<RecordingHandles['dir']>;
      const h: RecordingHandles = { recordingId: 'r', dir, hostStartMs: 1_000_000 };

      vi.setSystemTime(1_005_000);
      const hostShare = startScreenRecording(h, fakeScreen(), 'host', null);
      vi.setSystemTime(1_007_000);
      await bindHostScreenChannel(new EventTarget() as unknown as RTCDataChannel, h);
      vi.setSystemTime(1_008_000);
      release();
      await hostShare;

      expect(collectScreenSegments(h)).toEqual([
        { file: 'guest_screen_r.mp4', offsetMs: 7_000 },
        { file: 'host_screen_r.mp4', offsetMs: 8_000 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps screen offsets right after an empty guest segment is dropped', async () => {
    installMediaRecorder();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const dir = { ...fakeDir(), removeEntry: async () => {} };
      const h = { recordingId: 'r', dir, hostStartMs: 1_000_000 } as unknown as RecordingHandles;

      vi.setSystemTime(1_002_000);
      const channel = new EventTarget() as unknown as RTCDataChannel;
      await bindHostScreenChannel(channel, h);
      channel.dispatchEvent(new Event('close'));
      await vi.waitFor(() => expect(h.screenWriters).toEqual([]));

      vi.setSystemTime(1_005_000);
      await startScreenRecording(h, fakeScreen(), 'host', null);

      expect(collectScreenSegments(h)).toEqual([{ file: 'host_screen_r.mp4', offsetMs: 5_000 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps finished screen backups on RecordingHandles.screenBackups across multiple stretches', async () => {
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'rec-backups-keep', dir: fakeDir() };
    await startScreenRecording(h, fakeScreen(), 'host', null);
    const backup1 = h.screenBackup;
    expect(backup1).toBeDefined();
    await stopScreenRecording(h);

    expect(h.screenBackups).toHaveLength(1);
    expect(h.screenBackups?.[0]).toBe(backup1);

    await startScreenRecording(h, fakeScreen(), 'host', null);
    const backup2 = h.screenBackup;
    expect(backup2).toBeDefined();
    expect(backup2).not.toBe(backup1);
    await stopScreenRecording(h);

    expect(h.screenBackups).toHaveLength(2);
    expect(h.screenBackups).toEqual([backup1, backup2]);
  });

  it('does not create a second MediaRecorder for the screen backup and writes chunks to it', async () => {
    let mrInstances = 0;
    class FakeMR {
      state = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        mrInstances++;
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.onstop?.();
      }
    }
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMR;
    (globalThis as { MediaRecorder: { isTypeSupported: (m: string) => boolean } }).MediaRecorder.isTypeSupported =
      () => true;

    const h: RecordingHandles = { recordingId: 'rec-one-encode', dir: fakeDir() };
    await startScreenRecording(h, fakeScreen(), 'host', null);

    expect(mrInstances).toBe(1);
    expect(h.screenBackup).toBeDefined();

    const writeChunkSpy = vi.spyOn(h.screenBackup!, 'writeChunk');
    const chunkData = new Uint8Array([1, 2, 3, 4]).buffer;
    const mr = (h.screenRecorder as any).mr;
    mr.ondataavailable?.({
      data: { size: 4, arrayBuffer: async () => chunkData } as unknown as Blob,
    });

    await vi.waitFor(() => {
      expect(writeChunkSpy).toHaveBeenCalledWith(chunkData);
    });

    await stopScreenRecording(h);
  });

  it('marks a screen segment ended early when the host screen receiver channel closes without recording-finalized', async () => {
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'r-interrupted', dir: fakeDir(), hostStartMs: 1_000_000 };
    const channel = new EventTarget() as unknown as RTCDataChannel;
    (channel as any).readyState = 'open';
    await bindHostScreenChannel(channel, h);

    const rec = (h.screenReceivers as Map<number, any>).get(1);
    await rec.handleMessage(JSON.stringify({ idx: 0, offset: 0, size: 4, ts: 100 }));
    await rec.handleMessage(new ArrayBuffer(4));

    channel.dispatchEvent(new Event('close'));

    await vi.waitFor(() => {
      const segments = collectScreenSegments(h);
      expect(segments).toHaveLength(1);
      expect((segments[0] as any)?.endedEarly).toBe(true);
    });
  });

  it('does not mark a screen segment ended early when recording-finalized was received before close', async () => {
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'r-clean', dir: fakeDir(), hostStartMs: 1_000_000 };
    const channel = new EventTarget() as unknown as RTCDataChannel;
    (channel as any).readyState = 'open';
    await bindHostScreenChannel(channel, h);

    const rec = (h.screenReceivers as Map<number, any>).get(1);
    await rec.handleMessage(JSON.stringify({ idx: 0, offset: 0, size: 4, ts: 100 }));
    await rec.handleMessage(new ArrayBuffer(4));

    await rec.handleMessage(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'r-clean', totalBytes: 4, sha256: 'abc' })
    );
    channel.dispatchEvent(new Event('close'));

    await vi.waitFor(() => {
      const segments = collectScreenSegments(h);
      expect(segments).toHaveLength(1);
      expect((segments[0] as any)?.endedEarly).toBeUndefined();
    });
  });

  it('collects sharer display name for both host and guest screen segments', async () => {
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'r-sharer', dir: fakeDir(), hostStartMs: 1_000_000 };

    // Host share with explicit sharer name
    await startScreenRecording(h, fakeScreen(), 'host', null, undefined, 'Host Alice');
    await stopScreenRecording(h);

    // Guest share with peerId resolved via getPeerName
    const channel = new EventTarget() as unknown as RTCDataChannel;
    (channel as any).readyState = 'open';
    await bindHostScreenChannel(channel, h, undefined, 'peer-bob');

    const getPeerName = (peerId: string) => (peerId === 'peer-bob' ? 'Bob' : undefined);
    const segments = collectScreenSegments(h, getPeerName);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.sharer).toBe('Host Alice');
    expect(segments[1]?.sharer).toBe('Bob');
  });

  it('two channels bound in the same tick get two files', async () => {
    files.length = 0;
    const h: RecordingHandles = { recordingId: 'rec-same-tick', dir: fakeDir() };
    const c1 = new EventTarget() as unknown as RTCDataChannel;
    const c2 = new EventTarget() as unknown as RTCDataChannel;

    await Promise.all([
      bindHostScreenChannel(c1, h, undefined, 'peer-b'),
      bindHostScreenChannel(c2, h, undefined, 'peer-c'),
    ]);

    expect(files).toEqual(['guest_screen_rec-same-tick.mp4', 'guest_screen_rec-same-tick_2.mp4']);
    expect(h.screenReceivers?.size).toBe(2);
    expect([...(h.screenLive?.entries() ?? [])]).toEqual([
      [1, 'peer-b'],
      [2, 'peer-c'],
    ]);
    expect(h.screenWriters).toHaveLength(2);
    expect(h.screenWriters?.map((w) => w.fileName)).toEqual([
      'guest_screen_rec-same-tick.mp4',
      'guest_screen_rec-same-tick_2.mp4',
    ]);
  });

  it('bytes go to the right file when two channels bind in the same tick', async () => {
    const writtenByFile = new Map<string, Uint8Array[]>();
    const dir = {
      getFileHandle: async (name: string) => ({
        name,
        createWritable: async () => ({
          write: async (op: { type?: string; position?: number; data?: ArrayBuffer | ArrayBufferView }) => {
            if (op?.data) {
              const list = writtenByFile.get(name) ?? [];
              const raw = op.data instanceof Uint8Array ? op.data : new Uint8Array(op.data as ArrayBuffer);
              list.push(new Uint8Array(raw));
              writtenByFile.set(name, list);
            }
          },
          close: async () => {},
        }),
      }),
    } as unknown as NonNullable<RecordingHandles['dir']>;

    const h: RecordingHandles = { recordingId: 'rec-bytes', dir };
    const c1 = new EventTarget() as unknown as RTCDataChannel;
    const c2 = new EventTarget() as unknown as RTCDataChannel;

    await Promise.all([
      bindHostScreenChannel(c1, h, undefined, 'peer-b'),
      bindHostScreenChannel(c2, h, undefined, 'peer-c'),
    ]);

    const chunk1 = new Uint8Array([1, 2, 3, 4]);
    const chunk2 = new Uint8Array([5, 6, 7, 8]);
    (c1 as any).onmessage?.({ data: JSON.stringify({ idx: 0, offset: 0, size: chunk1.byteLength, ts: 100 }) } as MessageEvent);
    (c1 as any).onmessage?.({ data: chunk1.buffer } as MessageEvent);
    (c2 as any).onmessage?.({ data: JSON.stringify({ idx: 0, offset: 0, size: chunk2.byteLength, ts: 100 }) } as MessageEvent);
    (c2 as any).onmessage?.({ data: chunk2.buffer } as MessageEvent);

    await vi.waitFor(() => {
      expect(writtenByFile.get('guest_screen_rec-bytes.mp4')).toEqual([chunk1]);
      expect(writtenByFile.get('guest_screen_rec-bytes_2.mp4')).toEqual([chunk2]);
    });
  });

  it('an empty share ending does not remove the other share file', async () => {
    const removed: string[] = [];
    const dir = {
      ...fakeDir(),
      removeEntry: async (n: string) => {
        removed.push(n);
      },
    };
    const h: RecordingHandles = { recordingId: 'rec-empty-survive', dir };
    const c1 = new EventTarget() as unknown as RTCDataChannel;
    const c2 = new EventTarget() as unknown as RTCDataChannel;
    (c1 as any).readyState = 'open';
    (c2 as any).readyState = 'open';

    await Promise.all([
      bindHostScreenChannel(c1, h, undefined, 'peer-b'),
      bindHostScreenChannel(c2, h, undefined, 'peer-c'),
    ]);

    const chunk = new Uint8Array([1, 2, 3, 4]);
    (c2 as any).onmessage?.({ data: JSON.stringify({ idx: 0, offset: 0, size: chunk.byteLength, ts: 100 }) } as MessageEvent);
    (c2 as any).onmessage?.({ data: chunk.buffer } as MessageEvent);

    c1.dispatchEvent(new Event('close'));

    await vi.waitFor(() => {
      expect(removed).toEqual(['guest_screen_rec-empty-survive.mp4']);
    });
    expect(h.screenWriters).toHaveLength(1);
    expect(h.screenWriters?.[0]?.fileName).toBe('guest_screen_rec-empty-survive_2.mp4');
    expect([...(h.screenLive?.entries() ?? [])]).toEqual([[2, 'peer-c']]);
  });

  it('the second share ending empty leaves the first share alone', async () => {
    const removed: string[] = [];
    const dir = { ...fakeDir(), removeEntry: async (n: string) => { removed.push(n); } };
    const h: RecordingHandles = { recordingId: 'rec-second-empty', dir };
    const c1 = new EventTarget() as unknown as RTCDataChannel;
    const c2 = new EventTarget() as unknown as RTCDataChannel;
    await Promise.all([
      bindHostScreenChannel(c1, h, undefined, 'peer-b'),
      bindHostScreenChannel(c2, h, undefined, 'peer-c'),
    ]);
    const chunk = new Uint8Array([1, 2, 3, 4]);
    (c1 as any).onmessage?.({ data: JSON.stringify({ idx: 0, offset: 0, size: 4, ts: 100 }) } as MessageEvent);
    (c1 as any).onmessage?.({ data: chunk.buffer } as MessageEvent);

    c2.dispatchEvent(new Event('close'));

    await vi.waitFor(() => expect(removed).toEqual(['guest_screen_rec-second-empty_2.mp4']));
    expect(h.screenWriters?.map((w) => w.fileName)).toEqual(['guest_screen_rec-second-empty.mp4']);
    expect([...(h.screenLive?.entries() ?? [])]).toEqual([[1, 'peer-b']]);
  });

  it('files that open out of order keep each share on its own number', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = fakeDir();
    const dir = {
      getFileHandle: async (name: string) => {
        if (name === 'guest_screen_rec-order.mp4') await gate; // the first file opens slowly
        return base.getFileHandle(name);
      },
    } as unknown as NonNullable<RecordingHandles['dir']>;
    const h: RecordingHandles = { recordingId: 'rec-order', dir };
    const c1 = new EventTarget() as unknown as RTCDataChannel;
    const c2 = new EventTarget() as unknown as RTCDataChannel;

    const first = bindHostScreenChannel(c1, h, undefined, 'peer-b');
    await bindHostScreenChannel(c2, h, undefined, 'peer-c');
    release();
    await first;

    const chunk = new Uint8Array([9, 9, 9, 9]);
    (c2 as any).onmessage?.({ data: JSON.stringify({ idx: 0, offset: 0, size: 4, ts: 100 }) } as MessageEvent);
    (c2 as any).onmessage?.({ data: chunk.buffer } as MessageEvent);

    const peers: HealthPeer[] = [
      { peerId: 'peer-b', name: 'Bo', expected: false },
      { peerId: 'peer-c', name: 'Cy', expected: false },
    ];
    await vi.waitFor(() =>
      expect(collectTrackHealth(h, peers)).toEqual([
        { key: 's1', who: 'Bo', track: 'screen', bytes: 0 },
        { key: 's2', who: 'Cy', track: 'screen', bytes: 4 },
      ])
    );
  });

  it('sequential shares keep their names', async () => {
    files.length = 0;
    const h: RecordingHandles = { recordingId: 'rec-seq', dir: fakeDir() };
    const c1 = new EventTarget() as unknown as RTCDataChannel;
    const c2 = new EventTarget() as unknown as RTCDataChannel;
    const c3 = new EventTarget() as unknown as RTCDataChannel;

    await bindHostScreenChannel(c1, h);
    await bindHostScreenChannel(c2, h);
    await bindHostScreenChannel(c3, h);

    expect(files).toEqual([
      'guest_screen_rec-seq.mp4',
      'guest_screen_rec-seq_2.mp4',
      'guest_screen_rec-seq_3.mp4',
    ]);
  });

  it('handles that already hold segments continue after them', async () => {
    files.length = 0;
    const existingReceivers = new Map<number, any>([
      [1, {}],
      [2, {}],
    ]);
    const h: RecordingHandles = {
      recordingId: 'rec-continue',
      dir: fakeDir(),
      screenReceivers: existingReceivers,
    };
    const c = new EventTarget() as unknown as RTCDataChannel;

    await bindHostScreenChannel(c, h);

    expect(files).toEqual(['guest_screen_rec-continue_3.mp4']);
  });

  it('carries sender facts for a guest screen segment', async () => {
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'r-facts', dir: fakeDir(), hostStartMs: 1_000_000 };
    const channel = new EventTarget() as unknown as RTCDataChannel;
    (channel as any).readyState = 'open';
    await bindHostScreenChannel(channel, h);

    const rec = (h.screenReceivers as Map<number, any>).get(1);
    await rec.handleMessage(JSON.stringify({ idx: 0, offset: 0, size: 4, ts: 100 }));
    await rec.handleMessage(new ArrayBuffer(4));

    await rec.handleMessage(
      JSON.stringify({ type: 'recording-finalized', recordingId: 'r-facts', totalBytes: 4, sha256: 'abc' })
    );
    channel.dispatchEvent(new Event('close'));

    await vi.waitFor(async () => {
      const checks = await collectFileChecks(h);
      expect(checks.get('guest_screen_r-facts.mp4')?.received).toMatchObject({
        finalized: true,
        sha256Sent: 'abc',
      });
    });
  });

  it('gives a host screen segment an entry and no received facts', async () => {
    installMediaRecorder();
    const h2: RecordingHandles = { recordingId: 'r-own', dir: fakeDir(), hostStartMs: 1_000_000 };
    await startScreenRecording(h2, fakeScreen(), 'host', null);
    await stopScreenRecording(h2);
    const checks = await collectFileChecks(h2);
    expect(checks.get('host_screen_r-own.mp4')).toBeDefined();
    expect(checks.get('host_screen_r-own.mp4')?.received).toBeUndefined();
  });

  it('notes a guest screen segment under the sharer name and hands its receiver the journal file', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_759_824_000_000);
      const h: RecordingHandles = {
        recordingId: 'r-journal',
        dir: fakeDir(),
        // Bob's camera channel was bound to slot 0 under his name.
        slotPeerIds: new Map([[0, 'peer-bob']]),
        slotNames: new Map([[0, 'Bob']]),
      };
      const { journal, names } = fakeJournal();
      h.journal = journal;
      const channel = new EventTarget() as unknown as RTCDataChannel;
      (channel as any).readyState = 'open';

      await bindHostScreenChannel(channel, h, undefined, 'peer-bob');

      expect(journal.notes.files).toEqual([
        {
          file: 'guest_screen_r-journal.mp4',
          kind: 'screen',
          segment: 1,
          startedAtMs: 1759824000000,
          who: 'Bob',
        },
      ]);
      expect(names).toEqual(['guest_screen_r-journal.mp4']);
      expect(journal.notes.backups).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never stores the socket peer id as the sharer of a screen note', async () => {
    const h: RecordingHandles = { recordingId: 'r-who', dir: fakeDir() };
    const { journal } = fakeJournal();
    h.journal = journal;
    const share = async (peerId: string, name?: string) => {
      const channel = new EventTarget() as unknown as RTCDataChannel;
      (channel as any).readyState = 'open';
      await bindHostScreenChannel(channel, h, undefined, peerId, name);
    };

    // A present-only device has no camera slot, so no name is known for it.
    await share('0b6e1c1e-socket-peer-id');
    // A name handed in is cleaned and cut like every other name in the notes.
    await share('0b6e1c1e-socket-peer-id', 'Dee\n\u202Egnp.exe');
    await share('0b6e1c1e-socket-peer-id', 'S'.repeat(300));

    expect(journal.notes.files.map((f) => f.who)).toEqual([undefined, 'Dee gnp.exe', 'S'.repeat(200)]);
    expect('who' in journal.notes.files[0]!).toBe(false);
  });

  it('lets one sharer hold 12 screen notes and the take 48; a share past either has no crash copy', async () => {
    const h: RecordingHandles = { recordingId: 'r-cap', dir: fakeDir() };
    const { journal, names } = fakeJournal();
    h.journal = journal;
    const share = async (peerId: string) => {
      const sent: string[] = [];
      const channel = new EventTarget() as unknown as RTCDataChannel;
      (channel as any).readyState = 'open';
      (channel as any).send = (data: string) => sent.push(data);
      await bindHostScreenChannel(channel, h, undefined, peerId);
      return { channel, sent };
    };
    const screenNotes = () => journal.notes.files.filter((f) => f.kind === 'screen');

    for (let i = 0; i < 12; i++) await share('peer-a');
    const thirteenth = await share('peer-a');
    expect(screenNotes()).toHaveLength(12);
    // The thirteenth is still recorded and listed. It has no note and no file in
    // the crash copy, so the guest is acknowledged from the folder write: five
    // fragments at one instant are enough for an ack, with no commit to wait for.
    expect(h.screenWriters).toHaveLength(13);
    expect(names).toHaveLength(12);
    expect(names).not.toContain('guest_screen_r-cap_13.mp4');
    for (let idx = 0; idx < 5; idx++) {
      (thirteenth.channel as any).onmessage({ data: JSON.stringify({ idx, offset: idx * 4, size: 4, ts: 0 }) });
      (thirteenth.channel as any).onmessage({ data: new ArrayBuffer(4) });
    }
    await vi.waitFor(() =>
      expect(thirteenth.sent.map((m) => JSON.parse(m))).toEqual([
        { type: 'ack', recordingId: 'r-cap', uptoIdx: 4, uptoOffset: 20 },
      ])
    );

    // Another sharer is not crowded out by the first.
    await share('peer-b');
    expect(screenNotes()).toHaveLength(13);
    expect(names).toContain('guest_screen_r-cap_14.mp4');

    // The bound for the whole take still holds across sharers.
    for (const peerId of ['peer-c', 'peer-d', 'peer-e']) {
      for (let i = 0; i < 12; i++) await share(peerId);
    }
    expect(screenNotes()).toHaveLength(48);
    expect(names).toHaveLength(48);
    expect(h.screenWriters).toHaveLength(50);
  });

  it('tells the host when the crash copy of a screen file stops being kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const warns: string[] = [];
      const h: RecordingHandles = { recordingId: 'r-dead', dir: fakeDir(), onWarn: (m) => warns.push(m) };
      // Browser storage stops taking parts: the file reads dead once a commit ran.
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
      const sent: string[] = [];
      const channel = new EventTarget() as unknown as RTCDataChannel;
      (channel as any).readyState = 'open';
      (channel as any).send = (data: string) => sent.push(data);
      await bindHostScreenChannel(channel, h, undefined, 'peer-bob');

      const fragment = (idx: number) => {
        (channel as any).onmessage({ data: JSON.stringify({ idx, offset: idx * 4, size: 4, ts: 0 }) });
        (channel as any).onmessage({ data: new ArrayBuffer(4) });
      };
      fragment(0);
      await new Promise((r) => setTimeout(r, 0));
      vi.setSystemTime(Date.now() + 2000);
      fragment(1);

      await vi.waitFor(() => expect(warns).toHaveLength(1));
      expect(warns[0]).toContain('Crash protection stopped');
      // The sharer is still acknowledged, from the folder write.
      expect(sent.map((m) => JSON.parse(m)).at(-1)).toEqual({
        type: 'ack',
        recordingId: 'r-dead',
        uptoIdx: 1,
        uptoOffset: 8,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the note of a guest share stopped before its first chunk', async () => {
    const removed: string[] = [];
    const dir = { ...fakeDir(), removeEntry: async (n: string) => { removed.push(n); } };
    const h = { recordingId: 'r1', dir } as unknown as RecordingHandles;
    const { journal } = fakeJournal();
    h.journal = journal;
    const channel = new EventTarget() as unknown as RTCDataChannel;
    (channel as any).readyState = 'open';
    await bindHostScreenChannel(channel, h);
    expect(journal.notes.files.map((f) => f.file)).toEqual(['guest_screen_r1.mp4']);

    channel.dispatchEvent(new Event('close'));
    await vi.waitFor(() => expect(removed).toEqual(['guest_screen_r1.mp4']));
    // The note named a file that is gone, so a resume must not open it.
    expect(journal.notes.files).toEqual([]);
  });
});

/**
 * A resumed take starts its segment counter again, so the first share after the
 * reload would open the number the crashed tab left in the folder — and opening
 * a name replaces the file. The folder itself is asked which numbers are free.
 */
describe('a screen share after a resume', () => {
  /** `seeded` are the names already in the folder: only those resolve a probe. */
  function seededDir(opened: string[], probes: string[], seeded: string[]) {
    const holds = new Set(seeded);
    return {
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (!opts?.create) {
          probes.push(name);
          if (!holds.has(name)) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        } else {
          opened.push(name);
          holds.add(name);
        }
        return {
          name,
          createWritable: async () => ({ write: async () => {}, close: async () => {} }),
        };
      },
    } as unknown as NonNullable<RecordingHandles['dir']>;
  }

  it('opens the next free number instead of the file the crash left', async () => {
    installMediaRecorder();
    const opened: string[] = [];
    const probes: string[] = [];
    const h: RecordingHandles = {
      recordingId: 'rec',
      resumed: true,
      dir: seededDir(opened, probes, ['host_screen_rec.mp4']),
    };

    await startScreenRecording(h, fakeScreen(), 'host', null);

    expect(opened).toEqual(['host_screen_rec_2.mp4']);
    expect(probes[0]).toBe('host_screen_rec.mp4');
    expect(h.screenSegment).toBe(2);
    await stopScreenRecording(h);
  });

  it('steps past every screen file the folder holds', async () => {
    installMediaRecorder();
    const opened: string[] = [];
    const probes: string[] = [];
    const h: RecordingHandles = {
      recordingId: 'rec',
      resumed: true,
      dir: seededDir(opened, probes, ['host_screen_rec.mp4', 'host_screen_rec_2.mp4']),
    };

    await startScreenRecording(h, fakeScreen(), 'host', null);

    expect(opened).toEqual(['host_screen_rec_3.mp4']);
    expect(h.screenSegment).toBe(3);
    await stopScreenRecording(h);
  });

  it('leaves a fresh take to open its own number without probing', async () => {
    installMediaRecorder();
    const opened: string[] = [];
    const probes: string[] = [];
    const h: RecordingHandles = { recordingId: 'new-id', dir: seededDir(opened, probes, ['host_screen_new-id.mp4']) };

    await startScreenRecording(h, fakeScreen(), 'host', null);

    expect(opened).toEqual(['host_screen_new-id.mp4']);
    expect(probes).toEqual([]);
    await stopScreenRecording(h);
  });

  it('records no host screen file when the folder has no free name for it', async () => {
    installMediaRecorder();
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
    const h: RecordingHandles = { recordingId: 'rec', resumed: true, dir };

    await startScreenRecording(h, fakeScreen(), 'host', null, (e) => errors.push(e));

    expect(lookups).toHaveLength(50);
    expect(opened).toEqual([]);
    expect(h.screenRecorder).toBeUndefined();
    expect(h.screenSegment).toBeUndefined();
    expect(errors.map((e) => (e as Error).message)).toEqual([
      'Your screen is not being recorded: the folder has no free file name left for it.',
    ]);
  });
});

/**
 * A resume uses the screen notes for more than the next number. Each screen
 * file from before the reload is put back in the folder from the crash copy and
 * listed, so the summary and the sync file have it with its size.
 */
describe('screen files from before the reload', () => {
  const T0 = 1_759_824_000_000;
  const emptyStream = () =>
    ({ getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] }) as unknown as MediaStream;

  /** A folder that knows each file's length and replaces a file when one opened for writing is closed. */
  function folder(seed: Record<string, number> = {}, refuseWrite?: (nth: number) => boolean) {
    const sizes = new Map(Object.entries(seed));
    const opened: string[] = [];
    const dir = {
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (!sizes.has(name)) {
          if (!opts?.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
          sizes.set(name, 0);
        }
        return {
          name,
          getFile: async () => ({ size: sizes.get(name)! }),
          createWritable: async () => {
            opened.push(name);
            let end = 0;
            let writes = 0;
            return {
              write: async (d: { position: number; data: ArrayBuffer | Blob }) => {
                writes += 1;
                if (refuseWrite?.(writes)) throw new Error('disk full');
                end = Math.max(end, d.position + (d.data instanceof Blob ? d.data.size : d.data.byteLength));
              },
              close: async () => {
                sizes.set(name, end);
              },
            };
          },
        };
      },
    } as unknown as NonNullable<RecordingHandles['dir']>;
    return { dir, opened, size: (name: string) => sizes.get(name) };
  }

  /** A crashed take's journal in browser storage, read back the way the next session finds it. */
  async function crashedTake(shares: { file: string; segment: number; atMs: number; who?: string; parts: number[] }[]) {
    const root = new FakeDirectoryHandle('root');
    const getRoot = async () => root as never;
    const live = (await openTakeJournal(
      { room: 'abc-defg-hij', recordingId: 'rec', take: 1, hostStartMs: T0 },
      getRoot
    ))!;
    for (const share of shares) {
      live.note((n) =>
        n.files.push({
          file: share.file,
          kind: 'screen',
          segment: share.segment,
          startedAtMs: T0 + share.atMs,
          ...(share.who ? { who: share.who } : {}),
        })
      );
      const file = live.file(share.file);
      let offset = 0;
      for (const [i, size] of share.parts.entries()) {
        file.append(offset, new Uint8Array(size).fill(i + 1).buffer);
        await file.commit(i + 1);
        offset += size;
      }
    }
    const [journal] = await findTakeJournals(getRoot);
    return journal!;
  }

  it('puts a share that was running at the crash back from the crash copy, and lists it', async () => {
    const journal = await crashedTake([
      { file: 'guest_screen_rec.mp4', segment: 1, atMs: 6800, who: 'Bo', parts: [100, 200] },
    ]);
    // The crash left the folder's file empty: it was never closed.
    const f = folder({ 'guest_screen_rec.mp4': 0 });
    const errors: unknown[] = [];

    const h = await resumeHostRecording({
      journal,
      dir: f.dir,
      localStream: emptyStream(),
      channels: [],
      onError: (e) => errors.push(e),
    });

    expect(errors).toEqual([]);
    expect(f.size('guest_screen_rec.mp4')).toBe(300);
    expect(collectScreenSegments(h, () => undefined)).toEqual([
      { file: 'guest_screen_rec.mp4', offsetMs: 6800, endedEarly: true, sharer: 'Bo' },
    ]);
    expect((await collectFileChecks(h)).get('guest_screen_rec.mp4')).toEqual({ bytes: 300, recovered: true });

    // The next share still takes a new number, and both are listed in order.
    const channel = new EventTarget() as unknown as RTCDataChannel;
    (channel as any).readyState = 'open';
    await bindHostScreenChannel(channel, h, undefined, 'peer-b');
    expect(f.opened).toEqual(['guest_screen_rec.mp4', 'guest_screen_rec_2.mp4']);
    expect(collectScreenSegments(h, () => undefined).map((s) => s.file)).toEqual([
      'guest_screen_rec.mp4',
      'guest_screen_rec_2.mp4',
    ]);
  });

  it('leaves a share that ended before the crash as the folder has it, and lists it', async () => {
    const journal = await crashedTake([{ file: 'guest_screen_rec.mp4', segment: 1, atMs: 4100, parts: [100, 200] }]);
    // The share stopped before the crash, so its file was closed whole.
    const f = folder({ 'guest_screen_rec.mp4': 300 });

    const h = await resumeHostRecording({ journal, dir: f.dir, localStream: emptyStream(), channels: [] });

    expect(f.opened).toEqual([]);
    expect(f.size('guest_screen_rec.mp4')).toBe(300);
    expect(collectScreenSegments(h, () => undefined)).toEqual([
      { file: 'guest_screen_rec.mp4', offsetMs: 4100, endedEarly: true },
    ]);
    expect((await collectFileChecks(h)).get('guest_screen_rec.mp4')).toEqual({ bytes: 300, recovered: true });
  });

  it('lists a share it could not put back whole as incomplete, and says so', async () => {
    const journal = await crashedTake([
      { file: 'guest_screen_rec.mp4', segment: 1, atMs: 6800, who: 'Bo', parts: [100, 200] },
      { file: 'guest_screen_rec_2.mp4', segment: 2, atMs: 9000, who: 'Bo', parts: [50] },
    ]);
    // The folder refuses the second write to a file: the first share's second part.
    const f = folder({}, (nth) => nth === 2);
    const errors: unknown[] = [];

    const h = await resumeHostRecording({
      journal,
      dir: f.dir,
      localStream: emptyStream(),
      channels: [],
      onError: (e) => errors.push(e),
    });

    expect(errors.map((e) => (e as Error).message)).toEqual([
      'A screen recording from before the reload could not be fully rebuilt from the crash copy. The sharer has it in their own backup.',
    ]);
    // Both are listed: the one with a hole, and the one after it, which is whole.
    expect(collectScreenSegments(h, () => undefined).map((s) => [s.file, s.offsetMs])).toEqual([
      ['guest_screen_rec.mp4', 6800],
      ['guest_screen_rec_2.mp4', 9000],
    ]);
    const checks = await collectFileChecks(h);
    expect(checks.get('guest_screen_rec_2.mp4')).toEqual({ bytes: 50, recovered: true });
    const verdict = fileVerdict(checks.get('guest_screen_rec.mp4'), 'Bo', 'screen');
    expect(checks.get('guest_screen_rec.mp4')?.bytes).toBe(100);
    expect(verdict.status).toBe('incomplete');
    expect(verdict.text).toContain('Ask Bo for the backup');
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  bindHostScreenChannel,
  collectScreenSegments,
  endHostRecording,
  collectTrackHealth,
  collectFileChecks,
  resumeHostRecording,
  startGuestRecording,
  startScreenRecording,
  stopScreenRecording,
  type HealthPeer,
  type RecordingHandles,
} from '@/hooks/recording-controller';
import { ChunkReceiver } from '@/lib/chunk-receiver';
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

  it('a screen backup that cannot use browser storage warns through the take’s callback', async () => {
    installMediaRecorder();
    const onWarn = vi.fn();
    const h: RecordingHandles = { recordingId: 'rec-warn', dir: fakeDir(), onWarn };
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => { throw new Error('denied'); } } });
    try {
      await startScreenRecording(h, fakeScreen(), 'host', null);
      await h.screenBackup!.whenOpen();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(onWarn.mock.calls).toEqual([['Local storage is unavailable — backup lives in memory only.']]);
  });

  it('a guest’s screen backup warns through the callback its camera backup warns through', async () => {
    installMediaRecorder();
    const onWarn = vi.fn();
    const channel = () =>
      ({ readyState: 'open', addEventListener: vi.fn(), send: vi.fn(), close: vi.fn() }) as unknown as RTCDataChannel;
    const h = startGuestRecording({
      recordingId: 'rec-guest-warn',
      localStream: fakeScreen(),
      channel: channel(),
      onWarn,
    });
    expect(onWarn).toHaveBeenCalledTimes(1);

    await startScreenRecording(h, fakeScreen(), 'guest', { createRecordingScreenChannel: channel });

    expect(h.screenBackup).toBeDefined();
    expect(onWarn.mock.calls).toEqual([
      ['Local storage is unavailable — backup lives in memory only.'],
      ['Local storage is unavailable — backup lives in memory only.'],
    ]);
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

  describe('ending a take while a guest presents', () => {
    const finished = (id: string) =>
      JSON.stringify({ type: 'recording-finalized', recordingId: id, totalBytes: 4, sha256: 'abc' });

    // A camera receiver that has finished, a guest screen segment with four
    // bytes written, and a stream whose close rejects when it is called twice.
    async function presenting(sendsBytes = true) {
      installMediaRecorder();
      let closes = 0;
      const removed: string[] = [];
      const writable = {
        write: async () => {},
        close: async () => {
          closes++;
          await new Promise((r) => setTimeout(r, 10));
          if (closes > 1) throw new TypeError('Cannot close a closed or closing stream');
        },
      };
      const dir = {
        getFileHandle: async (name: string) => ({ name, createWritable: async () => writable }),
        removeEntry: async (name: string) => { removed.push(name); },
      } as unknown as NonNullable<RecordingHandles['dir']>;
      const camera = new ChunkReceiver({
        recordingId: 'r',
        writer: { write: async () => {}, close: async () => {}, fileName: 'cam.mp4' } as never,
        sendControl: () => {},
      });
      const h: RecordingHandles = {
        recordingId: 'r',
        dir,
        receiver: camera,
        channelRef: { current: { readyState: 'open' } as RTCDataChannel },
      };
      const channel = new EventTarget() as unknown as RTCDataChannel;
      (channel as any).readyState = 'open';
      const onError = vi.fn();
      await bindHostScreenChannel(channel, h, onError, 'peer-bob');
      const screen = (h.screenReceivers as Map<number, ChunkReceiver>).get(1)!;
      if (sendsBytes) {
        await screen.handleMessage(JSON.stringify({ idx: 0, offset: 0, size: 4, ts: 100 }));
        await screen.handleMessage(new ArrayBuffer(4));
      }
      return { h, channel, camera, screen, onError, removed, closes: () => closes };
    }

    it('keeps the screen file open until its own finish message arrives', async () => {
      // Removal that must fail this test: the screen receivers in pendingReceivers.
      const { h, camera, screen, onError, closes } = await presenting();
      await camera.handleMessage(finished('r'));

      const done = endHostRecording(h);
      await new Promise((r) => setTimeout(r, 20));
      expect(closes(), 'closed the screen file before its finish message').toBe(0);

      await screen.handleMessage(finished('r'));
      await done;

      expect(closes()).toBe(1);
      expect(h.screenEndedEarlyByFile?.size ?? 0).toBe(0);
      expect(collectScreenSegments(h)).toEqual([{ file: 'guest_screen_r.mp4', offsetMs: 0, sharer: 'peer-bob' }]);
      expect(onError).not.toHaveBeenCalled();
    });

    it.each(['before', 'after'])(
      'closes the file once when the channel closes %s the host closes it',
      async (order) => {
        // Removal that must fail this test: the shared close in FileWriter.close.
        const { h, channel, camera, screen, onError, closes } = await presenting();
        await camera.handleMessage(finished('r'));
        const done = endHostRecording(h);
        await screen.handleMessage(finished('r'));
        if (order === 'after') await vi.waitFor(() => expect(closes()).toBe(1), { interval: 1 });
        channel.dispatchEvent(new Event('close'));

        await expect(done).resolves.toBeDefined();
        await new Promise((r) => setTimeout(r, 30));

        expect(closes()).toBe(1);
        expect(h.screenEndedEarlyByFile?.size ?? 0).toBe(0);
        expect(onError).not.toHaveBeenCalled();
      }
    );

    it('ends at the limits for a screen file that never finishes and reports it ended early', async () => {
      // Removal that must fail this test: marking the unfinished segments after the wait.
      vi.useFakeTimers();
      try {
        const { h, camera } = await presenting();
        await camera.handleMessage(finished('r'));
        let ended = false;
        const done = endHostRecording(h).then(() => { ended = true; });

        await vi.advanceTimersByTimeAsync(44_000);
        expect(ended, 'gave up before the no-progress limit').toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        await done;

        expect(collectScreenSegments(h)).toEqual([
          { file: 'guest_screen_r.mp4', offsetMs: 0, endedEarly: true, sharer: 'peer-bob' },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not wait for a screen file whose channel closed before the take ended', async () => {
      // Removal that must fail this test: leaving the segment out of screenLive when its channel closes.
      vi.useFakeTimers();
      try {
        const { h, channel, camera, closes } = await presenting();
        await camera.handleMessage(finished('r'));
        channel.dispatchEvent(new Event('close'));
        await vi.advanceTimersByTimeAsync(20);
        expect(closes()).toBe(1);

        let ended = false;
        const done = endHostRecording(h).then(() => { ended = true; });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(ended, 'waited for a channel that was already closed').toBe(true);
        await done;
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops waiting for a screen file when its channel closes during the wait', async () => {
      // Removal that must fail this test: ending the receiver's wait in the screen channel's close listener.
      vi.useFakeTimers();
      try {
        const { h, channel, camera } = await presenting();
        await camera.handleMessage(finished('r'));
        let ended = false;
        const done = endHostRecording(h).then(() => { ended = true; });

        await vi.advanceTimersByTimeAsync(50);
        channel.dispatchEvent(new Event('close'));
        await vi.advanceTimersByTimeAsync(500);

        expect(ended, 'kept waiting for a channel that closed').toBe(true);
        await done;
        expect(collectScreenSegments(h)).toEqual([
          { file: 'guest_screen_r.mp4', offsetMs: 0, endedEarly: true, sharer: 'peer-bob' },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops the empty file of a share whose channel closes during the wait, and lists it nowhere', async () => {
      // Removal that must fail this test: ending the receiver's wait in the screen channel's close listener.
      vi.useFakeTimers();
      try {
        const { h, channel, camera, removed } = await presenting(false);
        await camera.handleMessage(finished('r'));
        let ended = false;
        const done = endHostRecording(h).then(() => { ended = true; });

        await vi.advanceTimersByTimeAsync(50);
        channel.dispatchEvent(new Event('close'));
        await vi.advanceTimersByTimeAsync(500);

        expect(ended, 'kept waiting for a channel that closed').toBe(true);
        await done;
        expect(removed).toEqual(['guest_screen_r.mp4']);
        expect(h.screenWriters).toEqual([]);
        expect([...(h.screenEndedEarlyByFile ?? [])]).toEqual([]);
        expect(collectScreenSegments(h)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not list an empty share file that was removed while another file was still awaited', async () => {
      // Removal that must fail this test: skipping the segments whose file is gone when marking ended early.
      const { h, channel, camera, removed } = await presenting(false);
      const done = endHostRecording(h);
      await new Promise((r) => setTimeout(r, 20));

      channel.dispatchEvent(new Event('close'));
      await vi.waitFor(() => expect(removed).toEqual(['guest_screen_r.mp4']));
      await camera.handleMessage(finished('r'));
      await done;

      expect([...(h.screenEndedEarlyByFile ?? [])]).toEqual([]);
      expect(collectScreenSegments(h)).toEqual([]);
    });

    it('lists a guest who is still sending a screen file until it is finished', async () => {
      // Removal that must fail this test: counting the screen receivers in the pending names.
      const { h, camera, screen } = await presenting();
      await camera.handleMessage(finished('r'));
      const lists: string[][] = [];

      const done = endHostRecording(h, {
        onProgress: (names) => lists.push(names),
        getPeerName: (id) => (id === 'peer-bob' ? 'Bob' : undefined),
      });
      await new Promise((r) => setTimeout(r, 20));
      await screen.handleMessage(finished('r'));
      await done;

      expect(lists).toEqual([['Guest', 'Bob'], ['Bob'], []]);
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

  it("ends a guest's screen files of a later take in _take<n>", async () => {
    files.length = 0;
    const h: RecordingHandles = { recordingId: 'rec-take2', dir: fakeDir(), take: 2 };

    await bindHostScreenChannel(new EventTarget() as unknown as RTCDataChannel, h, undefined, 'peer-b');
    await bindHostScreenChannel(new EventTarget() as unknown as RTCDataChannel, h, undefined, 'peer-c');

    expect(files).toEqual(['guest_screen_rec-take2_take2.mp4', 'guest_screen_rec-take2_2_take2.mp4']);
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

describe('a guest screen share whose connection is rebuilt', () => {
  const finished = (id: string) =>
    JSON.stringify({ type: 'recording-finalized', recordingId: id, totalBytes: 12, sha256: 'abc' });
  const fragment = (idx: number) => [
    JSON.stringify({ idx, offset: idx * 4, size: 4, ts: 100 }),
    new Uint8Array(4).fill(idx + 1).buffer,
  ];

  // A folder that keeps what its files were told: names asked for, byte
  // positions written, closes and removals.
  function folder() {
    const opened: string[] = [];
    const removed: string[] = [];
    const positions: number[] = [];
    let closes = 0;
    const writable = {
      write: async (op: { position: number }) => { positions.push(op.position); },
      close: async () => { closes++; },
    };
    const dir = {
      getFileHandle: async (name: string) => {
        opened.push(name);
        return { name, createWritable: async () => writable };
      },
      removeEntry: async (name: string) => { removed.push(name); },
    } as unknown as NonNullable<RecordingHandles['dir']>;
    return { dir, opened, removed, positions, closes: () => closes };
  }

  function channel(label: string) {
    const sent: { type: string; lastIdx?: number }[] = [];
    const ch = Object.assign(new EventTarget(), {
      label,
      readyState: 'open',
      send: (json: string) => { sent.push(JSON.parse(json)); },
    });
    return { ch: ch as unknown as RTCDataChannel, sent, close: () => ch.dispatchEvent(new Event('close')) };
  }

  const deliver = async (ch: RTCDataChannel, ...frames: (string | ArrayBuffer)[]) => {
    for (const f of frames) await ch.onmessage?.({ data: f } as MessageEvent);
  };

  const keyed = (key: string) => `recording-screen-1#${key}`;

  // Two fragments written on a first channel, then that channel closes with no finish message.
  async function dropped(label = keyed('share-key')) {
    const f = folder();
    const h: RecordingHandles = { recordingId: 'r', dir: f.dir };
    const first = channel(label);
    await bindHostScreenChannel(first.ch, h, undefined, 'peer-old');
    await deliver(first.ch, ...fragment(0), ...fragment(1));
    await vi.waitFor(() => expect(h.screenReceivers?.get(1)?.bytesWritten).toBe(8));
    first.close();
    await new Promise((r) => setTimeout(r, 5));
    return { f, h, first };
  }

  it('keeps the file open when a keyed channel closes before its finish message', async () => {
    // Removal that must fail this test: the keep-open branch of the close handler.
    const { f, h } = await dropped();

    expect(f.closes()).toBe(0);
    expect(f.opened).toEqual(['guest_screen_r.mp4']);
    expect([...(h.screenEndedEarlyByFile ?? [])]).toEqual(['guest_screen_r.mp4']);
    expect([...(h.screenLive?.keys() ?? [])]).toEqual([]);
  });

  it('continues the same file when a channel with the same key arrives', async () => {
    // Removal that must fail this test: the key lookup, so that a second file opens.
    const { f, h } = await dropped();
    const second = channel(keyed('share-key'));

    await bindHostScreenChannel(second.ch, h, undefined, 'peer-new');

    expect(f.opened).toEqual(['guest_screen_r.mp4']);
    expect(second.sent).toEqual([expect.objectContaining({ type: 'resume_offset', lastIdx: 1 })]);
    expect(second.ch.binaryType).toBe('arraybuffer');
    expect([...(h.screenLive?.entries() ?? [])]).toEqual([[1, 'peer-new']]);
    expect(h.screenSharerPeerIdsByFile?.get('guest_screen_r.mp4')).toBe('peer-new');
    expect([...(h.screenEndedEarlyByFile ?? [])]).toEqual([]);

    await deliver(second.ch, ...fragment(2));
    await vi.waitFor(() => expect(f.positions).toEqual([0, 4, 8]));

    await deliver(second.ch, finished('r'));
    second.close();
    await vi.waitFor(() => expect(f.closes()).toBe(1));
    expect(h.screenWriters).toHaveLength(1);
    expect([...(h.screenEndedEarlyByFile ?? [])]).toEqual([]);
    expect(collectScreenSegments(h)).toEqual([{ file: 'guest_screen_r.mp4', offsetMs: 0, sharer: 'peer-new' }]);
  });

  it('ignores the close of a channel the segment has moved on from', async () => {
    // Removal that must fail this test: the check that the closing channel is the current one.
    const { f, h, first } = await dropped();
    const second = channel(keyed('share-key'));
    await bindHostScreenChannel(second.ch, h, undefined, 'peer-new');

    first.close();
    await new Promise((r) => setTimeout(r, 5));

    expect(f.closes()).toBe(0);
    expect([...(h.screenLive?.keys() ?? [])]).toEqual([1]);
    expect([...(h.screenEndedEarlyByFile ?? [])]).toEqual([]);
  });

  it('removes the file of a keyed channel that closes before writing a byte', async () => {
    // Removal that must fail this test: the bytes-written condition of the keep-open branch.
    const f = folder();
    const h: RecordingHandles = { recordingId: 'r', dir: f.dir };
    const ch = channel(keyed('share-key'));
    await bindHostScreenChannel(ch.ch, h);

    ch.close();

    await vi.waitFor(() => expect(f.removed).toEqual(['guest_screen_r.mp4']));
    expect(f.closes()).toBe(1);
    expect(h.screenWriters).toEqual([]);
    expect(collectScreenSegments(h)).toEqual([]);
  });

  it('forgets the key of a finished file, so a later channel with it opens a new file', async () => {
    // Removal that must fail this test: forgetting the key when the file is closed.
    const { f, h } = await dropped();
    const second = channel(keyed('share-key'));
    await bindHostScreenChannel(second.ch, h, undefined, 'peer-new');
    await deliver(second.ch, finished('r'));
    second.close();
    await vi.waitFor(() => expect(f.closes()).toBe(1));

    await bindHostScreenChannel(channel(keyed('share-key')).ch, h, undefined, 'peer-new');

    expect(f.opened).toEqual(['guest_screen_r.mp4', 'guest_screen_r_2.mp4']);
  });

  it.each([`recording-screen-1#${'k'.repeat(65)}`, 'recording-screen-1#$', 'recording-screen-1#'])(
    'treats the label %s as a channel with no key',
    async (label) => {
      // Removal that must fail this test: the key shape check.
      const { f, h } = await dropped(label);
      expect(f.closes()).toBe(1);
      expect([...(h.screenEndedEarlyByFile ?? [])]).toEqual(['guest_screen_r.mp4']);

      await bindHostScreenChannel(channel(label).ch, h, undefined, 'peer-new');

      expect(f.opened).toEqual(['guest_screen_r.mp4', 'guest_screen_r_2.mp4']);
    }
  );

  describe('ending the take', () => {
    // Everything a take needs to end, with a finished camera, around a keyed share.
    async function presenting(label = keyed('share-key')) {
      const f = folder();
      const camera = new ChunkReceiver({
        recordingId: 'r',
        writer: { write: async () => {}, close: async () => {}, fileName: 'cam.mp4' } as never,
        sendControl: () => {},
      });
      await camera.handleMessage(finished('r'));
      const h: RecordingHandles = {
        recordingId: 'r',
        dir: f.dir,
        receiver: camera,
        channelRef: { current: { readyState: 'open' } as RTCDataChannel },
      };
      const first = channel(label);
      await bindHostScreenChannel(first.ch, h, undefined, 'peer-old');
      await deliver(first.ch, ...fragment(0), ...fragment(1));
      await vi.waitFor(() => expect(h.screenReceivers?.get(1)?.bytesWritten).toBe(8));
      return { f, h, first };
    }

    it('stops waiting for a keyed file when its channel closes during the wait', async () => {
      // Removal that must fail this test: the "take has not begun to end" condition of the keep-open branch.
      vi.useFakeTimers();
      try {
        const { h, first } = await presenting();
        let ended = false;
        const done = endHostRecording(h).then(() => { ended = true; });

        await vi.advanceTimersByTimeAsync(50);
        first.close();
        await vi.advanceTimersByTimeAsync(500);

        expect(ended, 'kept waiting for a channel that closed').toBe(true);
        await done;
        expect(collectScreenSegments(h)).toEqual([
          { file: 'guest_screen_r.mp4', offsetMs: 0, endedEarly: true, sharer: 'peer-old' },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes a kept-open file without waiting for it, and lists it ended early', async () => {
      // Removal that must fail this test: leaving the file out of screenLive when its channel closes.
      vi.useFakeTimers();
      try {
        const { f, h, first } = await presenting();
        first.close();
        await vi.advanceTimersByTimeAsync(10);
        let ended = false;
        const done = endHostRecording(h).then(() => { ended = true; });

        await vi.advanceTimersByTimeAsync(1_000);

        expect(ended, 'waited for a sharer that dropped').toBe(true);
        await done;
        expect(f.closes()).toBe(1);
        expect(collectScreenSegments(h)).toEqual([
          { file: 'guest_screen_r.mp4', offsetMs: 0, endedEarly: true, sharer: 'peer-old' },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits for a taken-up file and lists it complete when its finish message arrives', async () => {
      // Removal that must fail this test: ending the receiver's wait in the keep-open branch.
      const { f, h, first } = await presenting();
      first.close();
      await new Promise((r) => setTimeout(r, 5));
      const second = channel(keyed('share-key'));
      await bindHostScreenChannel(second.ch, h, undefined, 'peer-new');

      const done = endHostRecording(h);
      await new Promise((r) => setTimeout(r, 20));
      expect(f.closes(), 'closed the file before its finish message').toBe(0);
      await deliver(second.ch, finished('r'));
      await done;

      expect(f.closes()).toBe(1);
      expect(collectScreenSegments(h)).toEqual([{ file: 'guest_screen_r.mp4', offsetMs: 0, sharer: 'peer-new' }]);
    });
  });
});

describe('the key of a guest screen stretch', () => {
  const peerWith = (ch: RTCDataChannel) => {
    const keys: (string | undefined)[] = [];
    return { keys, peer: { createRecordingScreenChannel: (key?: string) => (keys.push(key), ch) } };
  };
  const openChannel = () =>
    Object.assign(new EventTarget(), { readyState: 'open', close: vi.fn(), send: vi.fn() }) as unknown as RTCDataChannel;

  it('is made for each stretch, put on its channel and cleared when the stretch stops', async () => {
    // Removal that must fail this test: clearing the key in stopScreenRecording.
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'rec-key' };
    const firstChannel = openChannel();
    const first = peerWith(firstChannel);

    await startScreenRecording(h, fakeScreen(), 'guest', first.peer);
    const firstKey = h.screenKey;
    (firstChannel as { readyState: string }).readyState = 'closed';

    expect(firstKey).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(first.keys).toEqual([firstKey]);

    await stopScreenRecording(h);
    expect(h.screenKey).toBeUndefined();

    const secondChannel = openChannel();
    const second = peerWith(secondChannel);
    await startScreenRecording(h, fakeScreen(), 'guest', second.peer);
    expect(second.keys).toEqual([h.screenKey]);
    expect(h.screenKey).not.toBe(firstKey);
    (secondChannel as { readyState: string }).readyState = 'closed';
    await stopScreenRecording(h);
  });

  it('is not kept when the stretch is rolled back', async () => {
    // Removal that must fail this test: clearing the key where the stretch is rolled back.
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'rec-key-rollback' };
    const screen = fakeScreen();
    const track = screen.getVideoTracks()[0] as { readyState: string };
    const ch = Object.assign(new EventTarget(), { readyState: 'connecting', close: vi.fn() }) as unknown as RTCDataChannel;

    const started = startScreenRecording(h, screen, 'guest', peerWith(ch).peer);
    track.readyState = 'ended';
    ch.dispatchEvent(new Event('open'));
    await started;

    expect(h.screenKey).toBeUndefined();
  });

  it('is not kept when its channel never opens', async () => {
    // Removal that must fail this test: clearing the key where the channel did not open.
    installMediaRecorder();
    vi.useFakeTimers();
    try {
      const h: RecordingHandles = { recordingId: 'rec-key-unopened' };
      const ch = Object.assign(new EventTarget(), { readyState: 'connecting', close: vi.fn() }) as unknown as RTCDataChannel;

      const started = startScreenRecording(h, fakeScreen(), 'guest', peerWith(ch).peer);
      await vi.advanceTimersByTimeAsync(15_000);
      await started;

      expect(h.screenKey).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not kept when the recorder fails to start', async () => {
    // Removal that must fail this test: clearing the key where the recorder failed to start.
    installMediaRecorder();
    const mr = (globalThis as unknown as { MediaRecorder: { prototype: { start: () => void } } }).MediaRecorder;
    const start = mr.prototype.start;
    mr.prototype.start = () => { throw new Error('MediaRecorder start failed'); };
    try {
      const h: RecordingHandles = { recordingId: 'rec-key-failed' };

      await startScreenRecording(h, fakeScreen(), 'guest', peerWith(openChannel()).peer, vi.fn());

      expect(h.screenKey).toBeUndefined();
    } finally {
      mr.prototype.start = start;
    }
  });

  it('is not made for the host’s own screen', async () => {
    // Removal that must fail this test: making the key outside the guest branch.
    installMediaRecorder();
    const h: RecordingHandles = { recordingId: 'rec-host', dir: fakeDir() };

    await startScreenRecording(h, fakeScreen(), 'host', null);

    expect(h.screenKey).toBeUndefined();
    await stopScreenRecording(h);
  });
});

describe('the keyed screen files one take keeps waiting', () => {
  const fragment = (idx: number) => [
    JSON.stringify({ idx, offset: idx * 4, size: 4, ts: 100 }),
    new Uint8Array(4).fill(idx + 1).buffer,
  ];

  // A folder that counts the files it opened and the ones closed.
  function folder() {
    let opened = 0;
    const closed = new Set<number>();
    const dir = {
      getFileHandle: async (name: string) => {
        const n = opened++;
        return { name, createWritable: async () => ({ write: async () => {}, close: async () => { closed.add(n); } }) };
      },
      removeEntry: async () => {},
    } as unknown as NonNullable<RecordingHandles['dir']>;
    return { dir, closed: () => [...closed].sort((a, b) => a - b), opened: () => opened };
  }

  // One keyed share that writes a fragment; its channel can be closed without a finish message.
  async function share(h: RecordingHandles, key: string) {
    const ch = Object.assign(new EventTarget(), {
      label: `recording-screen-1#${key}`,
      readyState: 'open',
      send: () => {},
    });
    await bindHostScreenChannel(ch as unknown as RTCDataChannel, h, undefined, `peer-${key}`);
    for (const f of fragment(0)) await (ch as unknown as RTCDataChannel).onmessage?.({ data: f } as MessageEvent);
    const seg = h.screenByKey?.get(key);
    await vi.waitFor(() => expect(seg?.receiver.bytesWritten).toBe(4));
    return {
      ch: ch as unknown as RTCDataChannel,
      drop: async () => {
        ch.dispatchEvent(new Event('close'));
        await new Promise((r) => setTimeout(r, 5));
      },
    };
  }

  it('closes the ninth file that waits and keeps the first eight open', async () => {
    // Removal that must fail this test: the bound on files waiting.
    const f = folder();
    const h: RecordingHandles = { recordingId: 'r', dir: f.dir };
    for (let n = 1; n <= 9; n++) await (await share(h, `k${n}`)).drop();

    expect(f.opened()).toBe(9);
    expect(f.closed()).toEqual([8]);
    expect([...(h.screenByKey?.keys() ?? [])]).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8']);
    expect(h.screenEndedEarlyByFile?.size).toBe(9);
  });

  it('does not count a file that was taken up again', async () => {
    // Removal that must fail this test: leaving the segment's live channel out of the count.
    const f = folder();
    const h: RecordingHandles = { recordingId: 'r', dir: f.dir };
    for (let n = 1; n <= 8; n++) await (await share(h, `k${n}`)).drop();
    const again = Object.assign(new EventTarget(), { label: 'recording-screen-1#k1', readyState: 'open', send: () => {} });
    await bindHostScreenChannel(again as unknown as RTCDataChannel, h, undefined, 'peer-new');

    await (await share(h, 'k9')).drop();
    expect(f.closed()).toEqual([]);

    await (await share(h, 'k10')).drop();
    expect(f.closed()).toEqual([9]);
  });

  it('does not count a file that was closed', async () => {
    // Removal that must fail this test: forgetting the key of a file that closes.
    const f = folder();
    const h: RecordingHandles = { recordingId: 'r', dir: f.dir };
    for (let n = 1; n <= 8; n++) await (await share(h, `k${n}`)).drop();
    const done = await share(h, 'k9');
    await done.drop();
    expect(f.closed()).toEqual([8]);

    await (await share(h, 'k10')).drop();

    expect(f.closed()).toEqual([8, 9]);
  });

  it('does not count the host’s own screen files', async () => {
    // Removal that must fail this test: counting every open screen writer instead of the keyed ones waiting.
    const f = folder();
    const h: RecordingHandles = { recordingId: 'r', dir: f.dir };
    installMediaRecorder();
    for (let n = 0; n < 8; n++) {
      await startScreenRecording(h, fakeScreen(), 'host', null);
      await stopScreenRecording(h);
    }
    expect(h.screenWriters).toHaveLength(8);

    await (await share(h, 'k1')).drop();

    expect(f.closed()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('the sharer of a keyed screen file after the guest reconnects', () => {
  it('is still named once the peer id it was bound under has left the room', async () => {
    // Removal that must fail this test: storing the name for the file in bindHostScreenChannel.
    const h: RecordingHandles = {
      recordingId: 'r',
      dir: fakeDir(),
      slotPeerIds: new Map([[0, 'peer-old']]),
      slotNames: new Map([[0, 'Bob']]),
    };
    const ch = Object.assign(new EventTarget(), {
      label: 'recording-screen-1#share-key',
      readyState: 'open',
      send: () => {},
    });
    await bindHostScreenChannel(ch as unknown as RTCDataChannel, h, undefined, 'peer-old');
    await (ch as unknown as RTCDataChannel).onmessage?.({
      data: JSON.stringify({ idx: 0, offset: 0, size: 4, ts: 100 }),
    } as MessageEvent);
    await (ch as unknown as RTCDataChannel).onmessage?.({ data: new Uint8Array(4).buffer } as MessageEvent);
    await vi.waitFor(() => expect(h.screenReceivers?.get(1)?.bytesWritten).toBe(4));
    ch.dispatchEvent(new Event('close'));
    h.slotPeerIds = new Map([[0, 'peer-new']]);

    expect(collectScreenSegments(h, () => undefined)).toEqual([
      { file: expect.stringMatching(/^guest_screen_r/), offsetMs: 0, endedEarly: true, sharer: 'Bob' },
    ]);
  });
});

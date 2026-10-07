import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncCallCopies, CALL_COPY_MAX_FILES, type RecordingHandles } from '@/hooks/recording-controller';

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supported: (m: string) => boolean = () => true;
  static isTypeSupported = (m: string) => FakeMediaRecorder.supported(m);
  static tailBytes = 0;

  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';

  constructor(public stream: MediaStream, public opts: { mimeType?: string }) {
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    if (FakeMediaRecorder.tailBytes) this.emit(FakeMediaRecorder.tailBytes);
    this.onstop?.();
  }
  emit(bytes: number) {
    const data = { size: bytes, arrayBuffer: async () => new ArrayBuffer(bytes) } as unknown as Blob;
    this.ondataavailable?.({ data });
  }
}

function fakeDir() {
  const files = new Map<string, { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>();
  const removeEntry = vi.fn().mockResolvedValue(undefined);
  const dir = {
    getFileHandle: vi.fn(async (name: string) => {
      const file = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
      files.set(name, file);
      return { name, createWritable: async () => file };
    }),
    removeEntry,
  };
  return { dir, files, removeEntry };
}

const track = () => ({ kind: 'audio', readyState: 'live' }) as unknown as MediaStreamTrack;
const peer = (peerId: string, t: MediaStreamTrack | null = track(), name?: string) => ({
  peerId,
  stream: t ? new MediaStream([t]) : null,
  ...(name !== undefined ? { name } : {}),
});
const handles = (dir: unknown): RecordingHandles => ({ recordingId: 'rec', dir: dir as never, hostStartMs: 1_000 });
const opened = (h: RecordingHandles) => Promise.all((h.callCopies ?? []).map((c) => c.opened));
const finished = (h: RecordingHandles) => Promise.all((h.callCopies ?? []).map((c) => c.finished));
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('syncCallCopies', () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.supported = () => true;
    FakeMediaRecorder.tailBytes = 0;
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  });

  afterEach(() => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    vi.restoreAllMocks();
  });

  it('a peer with a live audio track gets one file and one audio-only recorder', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    const t = track();
    const p = peer('p1', t);
    syncCallCopies(h, [p]);
    await opened(h);

    expect(files.size).toBe(1);
    expect(files.has('call1_rec.m4a')).toBe(true);
    expect(FakeMediaRecorder.instances.length).toBe(1);
    const mr = FakeMediaRecorder.instances[0]!;
    expect(mr.stream.getTracks()).toEqual([t]);
    expect(mr.opts.mimeType).toBe('audio/mp4;codecs=mp4a.40.2');

    mr.emit(10);
    await tick();
    mr.emit(6);
    await tick();
    const file = files.get('call1_rec.m4a')!;
    expect(file.write.mock.calls.map((c) => c[0].position)).toEqual([0, 10]);
    expect(file.write.mock.calls.map((c) => c[0].data.byteLength)).toEqual([10, 6]);
  });

  it('the blob the recorder hands over at stop is written before the file is closed', async () => {
    FakeMediaRecorder.tailBytes = 7;
    const { dir, files } = fakeDir();
    const h = handles(dir);
    syncCallCopies(h, [peer('p1')]);
    await opened(h);
    FakeMediaRecorder.instances[0]!.emit(10);
    await tick();
    syncCallCopies(h, []);
    await finished(h);
    const file = files.get('call1_rec.m4a')!;
    expect(file.write.mock.calls.map((c) => [c[0].position, c[0].data.byteLength])).toEqual([[0, 10], [10, 7]]);
    expect(file.write.mock.invocationCallOrder[1]!).toBeLessThan(file.close.mock.invocationCallOrder[0]!);
  });

  it('when only WebM is supported the file is call1_rec.webm', async () => {
    FakeMediaRecorder.supported = (m) => m.startsWith('audio/webm');
    const { dir, files } = fakeDir();
    const h = handles(dir);
    syncCallCopies(h, [peer('p1')]);
    await opened(h);

    expect(files.has('call1_rec.webm')).toBe(true);
    expect(files.size).toBe(1);
  });

  it('with take: 2 on the handles the file is call1_rec_take2.m4a', async () => {
    const { dir, files } = fakeDir();
    const h: RecordingHandles = { ...handles(dir), take: 2 };
    syncCallCopies(h, [peer('p1')]);
    await opened(h);

    expect(files.has('call1_rec_take2.m4a')).toBe(true);
  });

  it('calling syncCallCopies twice in a row with the same peer object opens ONE file and builds ONE recorder', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    const p = peer('p1');
    syncCallCopies(h, [p]);
    syncCallCopies(h, [p]);
    await opened(h);

    expect(files.size).toBe(1);
    expect(FakeMediaRecorder.instances.length).toBe(1);
  });

  it('the same peerId with a different track opens call2_rec.m4a and finishes the first', async () => {
    const { dir, files, removeEntry } = fakeDir();
    const h = handles(dir);
    const t1 = track();
    syncCallCopies(h, [peer('p1', t1)]);
    await opened(h);
    const mr1 = FakeMediaRecorder.instances[0]!;
    mr1.emit(10);
    await tick();

    const t2 = track();
    syncCallCopies(h, [peer('p1', t2)]);
    await opened(h);
    await finished(h);

    expect(files.has('call2_rec.m4a')).toBe(true);
    expect(mr1.state).toBe('inactive');
    const file1 = files.get('call1_rec.m4a')!;
    expect(file1.close).toHaveBeenCalledTimes(1);
    expect(removeEntry).not.toHaveBeenCalled();
    const mr2 = FakeMediaRecorder.instances[1]!;
    expect(mr2.state).toBe('recording');

    // Calling again with t2 does not open another file
    syncCallCopies(h, [peer('p1', t2)]);
    expect(files.size).toBe(2);

    // A 3rd track finishes the 2nd copy and opens call3_rec.m4a
    const t3 = track();
    mr2.emit(10);
    await tick();
    syncCallCopies(h, [peer('p1', t3)]);
    await opened(h);
    await finished(h);

    expect(files.has('call3_rec.m4a')).toBe(true);
    expect(mr2.state).toBe('inactive');
    const file2 = files.get('call2_rec.m4a')!;
    expect(file2.close).toHaveBeenCalledTimes(1);
  });

  it('the same peer cycling tracks t1 -> t2 -> t1 opens only two files', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    const t1 = track();
    const t2 = track();
    syncCallCopies(h, [peer('p1', t1)]);
    await opened(h);
    syncCallCopies(h, [peer('p1', t2)]);
    await opened(h);
    expect(files.size).toBe(2);

    syncCallCopies(h, [peer('p1', t1)]);
    await opened(h);
    expect(files.size).toBe(2);
    expect(h.callCopies?.length).toBe(2);
  });

  it('at the cap a peer whose stream is gone has its file closed whatever its place in the list', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    const peers = Array.from({ length: CALL_COPY_MAX_FILES }, (_, i) => peer(`p${i}`));
    syncCallCopies(h, peers);
    await opened(h);

    const mr0 = FakeMediaRecorder.instances[0]!;
    const file0 = files.get('call1_rec.m4a')!;

    const pNew = peer('pNew');
    syncCallCopies(h, [pNew, peer('p0', null), ...peers.slice(1)]);
    await finished(h);

    expect(mr0.state).toBe('inactive');
    expect(file0.close).toHaveBeenCalledTimes(1);
  });

  it('a peer still in the list whose stream became null has its copy finished and no new file opened', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    syncCallCopies(h, [peer('p1')]);
    await opened(h);
    const file1 = files.get('call1_rec.m4a')!;

    syncCallCopies(h, [peer('p1', null)]);
    await finished(h);

    expect(file1.close).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(1);
  });

  it('a peer missing from the next call has its copy finished while another peer stays recording', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    const p2 = peer('p2');
    syncCallCopies(h, [peer('p1'), p2]);
    await opened(h);
    const [mr1, mr2] = FakeMediaRecorder.instances;
    const file1 = files.get('call1_rec.m4a')!;
    const file2 = files.get('call2_rec.m4a')!;

    syncCallCopies(h, [p2]);
    await finished(h);

    expect(mr1!.state).toBe('inactive');
    expect(file1.close).toHaveBeenCalledTimes(1);
    expect(mr2!.state).toBe('recording');
    expect(file2.close).not.toHaveBeenCalled();
  });

  it('nothing is opened when h.dir is unset, stream is null, track ended, no mime supported, or callCopiesClosed', async () => {
    const { dir, files } = fakeDir();

    // h.dir unset
    const hNoDir = handles(undefined);
    syncCallCopies(hNoDir, [peer('p1')]);
    expect(FakeMediaRecorder.instances.length).toBe(0);
    expect(hNoDir.callCopies).toBeUndefined();

    // stream null
    const hStreamNull = handles(dir);
    syncCallCopies(hStreamNull, [peer('p1', null)]);
    expect(FakeMediaRecorder.instances.length).toBe(0);

    // track ended
    const hEnded = handles(dir);
    const tEnded = { kind: 'audio', readyState: 'ended' } as unknown as MediaStreamTrack;
    syncCallCopies(hEnded, [peer('p1', tEnded)]);
    expect(FakeMediaRecorder.instances.length).toBe(0);

    // no candidate mime supported
    FakeMediaRecorder.supported = () => false;
    const hNoMime = handles(dir);
    syncCallCopies(hNoMime, [peer('p1')]);
    expect(FakeMediaRecorder.instances.length).toBe(0);
    expect(hNoMime.callCopies).toHaveLength(0);
    FakeMediaRecorder.supported = () => true;

    // callCopiesClosed is true
    const hClosed: RecordingHandles = { ...handles(dir), callCopiesClosed: true };
    syncCallCopies(hClosed, [peer('p1')]);
    expect(FakeMediaRecorder.instances.length).toBe(0);

    expect(files.size).toBe(0);
  });

  it('no more than CALL_COPY_MAX_FILES files are opened in one take', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    const peers = Array.from({ length: CALL_COPY_MAX_FILES + 3 }, (_, i) => peer(`p${i}`));
    syncCallCopies(h, peers);
    await opened(h);

    expect(files.size).toBe(CALL_COPY_MAX_FILES);
    expect(h.callCopies?.length).toBe(CALL_COPY_MAX_FILES);
  });

  it('one guest presenting a new track over and over opens no more than the cap', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    for (let i = 0; i < CALL_COPY_MAX_FILES + 3; i++) {
      syncCallCopies(h, [peer('p1')]);
      await opened(h);
    }
    await finished(h);
    expect(files.size).toBe(CALL_COPY_MAX_FILES);
  });

  it('reconnects under a new peerId each time open no more than the cap', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    for (let i = 0; i < CALL_COPY_MAX_FILES + 3; i++) {
      syncCallCopies(h, [peer(`p${i}`)]);
      await opened(h);
    }
    await finished(h);
    expect(files.size).toBe(CALL_COPY_MAX_FILES);
  });

  it('a copy that recorded nothing is removed when finished and one with bytes is not', async () => {
    const { dir, removeEntry } = fakeDir();
    const h = handles(dir);
    syncCallCopies(h, [peer('p1'), peer('p2')]);
    await opened(h);
    FakeMediaRecorder.instances[1]!.emit(10);
    await tick();

    syncCallCopies(h, []);
    await finished(h);

    expect(removeEntry.mock.calls).toEqual([['call1_rec.m4a']]);
  });

  it('a copy told to finish while its file is still opening starts no recorder and is removed', async () => {
    const { dir, removeEntry } = fakeDir();
    const h = handles(dir);
    syncCallCopies(h, [peer('p1')]);
    syncCallCopies(h, []);
    await finished(h);

    expect(FakeMediaRecorder.instances.length).toBe(0);
    expect(removeEntry).toHaveBeenCalledWith('call1_rec.m4a');
  });

  it('a track that ended while its file was opening gets no recorder', async () => {
    const { dir } = fakeDir();
    const h = handles(dir);
    const t = { kind: 'audio', readyState: 'live' } as { kind: string; readyState: string };
    syncCallCopies(h, [peer('p1', t as never)]);
    t.readyState = 'ended';
    await opened(h);

    expect(FakeMediaRecorder.instances.length).toBe(0);
    expect(h.callCopies![0]!.startMs).toBeUndefined();
  });

  it('startMs is stamped when the recorder starts, and a copy that never started has none', async () => {
    const h = handles(fakeDir().dir);
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    syncCallCopies(h, [peer('p1')]);
    now = 2_000; // the file is still opening
    await opened(h);
    expect(h.callCopies![0]!.startMs).toBe(2_000);
  });

  it('the copy keeps a name only when non-empty string and stamps host clock at start', async () => {
    const { dir } = fakeDir();
    const h = handles(dir);
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    syncCallCopies(h, [peer('p1', track(), 'Dana'), peer('p2', track(), ''), peer('p3', track(), 42 as never)]);
    await opened(h);

    expect(h.callCopies?.map((c) => c.name)).toEqual(['Dana', undefined, undefined]);
    expect(h.callCopies?.[0]?.startMs).toBe(5_000);
  });

  it('a stream whose getAudioTracks throws does not throw out of syncCallCopies and logs a warning', () => {
    const { dir } = fakeDir();
    const h = handles(dir);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badStream = {
      getAudioTracks: () => {
        throw new Error('boom');
      },
    } as unknown as MediaStream;

    expect(() => syncCallCopies(h, [{ peerId: 'p1', stream: badStream }])).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith('openMeet: call audio copy', expect.any(Error));
  });

  it('a copy whose file rejects a write is stopped while another peer stays recording', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    syncCallCopies(h, [peer('p1'), peer('p2')]);
    await opened(h);

    const [mr1, mr2] = FakeMediaRecorder.instances;
    const file1 = files.get('call1_rec.m4a')!;
    file1.write.mockRejectedValue(new Error('write error'));
    mr1!.emit(10);
    await tick();
    await h.callCopies![0]!.finished;

    expect(mr1!.state).toBe('inactive');
    expect(mr2!.state).toBe('recording');
    expect(warnSpy).toHaveBeenCalledWith('openMeet: call audio copy', expect.any(Error));
  });

  it('a copy whose file failed to open keeps its entry and is not retried', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    const getFileHandle = vi.fn().mockRejectedValue(new Error('cannot open'));
    const dir = { getFileHandle, removeEntry };
    const h = handles(dir);
    const p = peer('p1');

    syncCallCopies(h, [p]);
    await opened(h);
    expect(getFileHandle).toHaveBeenCalledTimes(1);
    expect(h.callCopies?.length).toBe(1);

    syncCallCopies(h, [p]);
    await opened(h);
    expect(getFileHandle).toHaveBeenCalledTimes(1);
  });

  it('finishing a copy repeatedly is idempotent and does not close or stop multiple times', async () => {
    const { dir, files } = fakeDir();
    const h = handles(dir);
    syncCallCopies(h, [peer('p1')]);
    await opened(h);
    const file1 = files.get('call1_rec.m4a')!;

    syncCallCopies(h, []);
    syncCallCopies(h, []);
    await finished(h);

    expect(file1.close).toHaveBeenCalledTimes(1);
  });

  it('a copy told to finish while file open is in flight waits for open before removing entry', async () => {
    const { dir, removeEntry } = fakeDir();
    let resolveOpen: () => void = () => {};
    const openPromise = new Promise<void>((r) => { resolveOpen = r; });
    const origGet = dir.getFileHandle;
    dir.getFileHandle = vi.fn(async (name: string) => {
      await openPromise;
      return origGet(name);
    });
    const h = handles(dir);
    syncCallCopies(h, [peer('p1')]);
    syncCallCopies(h, []);
    resolveOpen();
    await finished(h);
    expect(removeEntry).toHaveBeenCalledWith('call1_rec.m4a');
  });

  it('a copy whose close rejects catches the error and logs a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, files } = fakeDir();
    const h = handles(dir);
    syncCallCopies(h, [peer('p1')]);
    await opened(h);
    const file1 = files.get('call1_rec.m4a')!;
    file1.close.mockRejectedValue(new Error('close failed'));

    syncCallCopies(h, []);
    await expect(finished(h)).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith('openMeet: call audio copy', expect.any(Error));
  });

  it('a copy whose write rejects leaves no file behind when finished', async () => {
    const { dir, files, removeEntry } = fakeDir();
    const h = handles(dir);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    syncCallCopies(h, [peer('p1')]);
    await opened(h);

    const mr = FakeMediaRecorder.instances[0]!;
    const file = files.get('call1_rec.m4a')!;
    file.write.mockRejectedValue(new Error('write failed'));
    mr.emit(10);
    await tick();
    await finished(h);

    expect(removeEntry).toHaveBeenCalledWith('call1_rec.m4a');
  });
});

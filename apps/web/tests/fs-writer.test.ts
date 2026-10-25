import { describe, it, expect, vi } from 'vitest';
import { FileWriter, isFsAccessSupported, pickRecordingDirectory } from '@/lib/fs-writer';
import { writeTakeSidecars } from '@/hooks/recording-controller';

function fakeWritable() {
  return { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
}

describe('FileWriter', () => {
  it('opens a file via the injected picker and writes at positions', async () => {
    const writable = fakeWritable();
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'guest.mp4' };
    const picker = vi.fn().mockResolvedValue(handle);

    const fw = new FileWriter({ picker });
    await fw.openFile('guest_abc.mp4');
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'guest_abc.mp4' })
    );

    const data = new Uint8Array([1, 2, 3]).buffer;
    await fw.write(0, data);
    await fw.write(2_000_000, data);
    expect(writable.write).toHaveBeenNthCalledWith(1, { type: 'write', position: 0, data });
    expect(writable.write).toHaveBeenNthCalledWith(2, { type: 'write', position: 2_000_000, data });
  });

  it('close() closes the writable', async () => {
    const writable = fakeWritable();
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'h.mp4' };
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue(handle) });
    await fw.openFile('h.mp4');
    await fw.close();
    expect(writable.close).toHaveBeenCalledOnce();
  });

  it('close() waits for a write that was not awaited', async () => {
    // Removal that must fail this test: the wait for queued writes in close().
    const order: string[] = [];
    const writable = {
      write: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('write finished');
      }),
      close: vi.fn().mockImplementation(async () => {
        order.push('close');
      }),
    };
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'h.mp4' };
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue(handle) });
    await fw.openFile('h.mp4');

    void fw.write(0, new Uint8Array([1]).buffer);
    await fw.close();

    expect(order).toEqual(['write finished', 'close']);
  });

  it('checkpoint() commits the stream and later writes go to the reopened one', async () => {
    // Removal that must fail this test: the late read of the stream in write(),
    // or the keepExistingData reopening in checkpoint().
    const first = fakeWritable();
    const second = fakeWritable();
    const createWritable = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue({ createWritable, name: 'c.m4a' }) });
    await fw.openFile('c.m4a');

    const a = new Uint8Array([1, 2]).buffer;
    const b = new Uint8Array([3]).buffer;
    void fw.write(0, a);
    const committed = fw.checkpoint();
    // Issued before the checkpoint has run: it must reach the reopened stream.
    const after = fw.write(2, b);
    await Promise.all([committed, after]);

    expect(first.write).toHaveBeenCalledWith({ type: 'write', position: 0, data: a });
    expect(first.close).toHaveBeenCalledOnce();
    expect(createWritable).toHaveBeenLastCalledWith({ keepExistingData: true });
    expect(second.write).toHaveBeenCalledWith({ type: 'write', position: 2, data: b });
    expect(fw.size).toBe(3);

    await fw.close();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('checkpoint() does nothing before the file is open or once it is closing', async () => {
    const fw = new FileWriter({ picker: vi.fn() });
    await expect(fw.checkpoint()).resolves.toBeUndefined();

    const writable = fakeWritable();
    const createWritable = vi.fn().mockResolvedValue(writable);
    const open = new FileWriter({ picker: vi.fn().mockResolvedValue({ createWritable, name: 'h.mp4' }) });
    await open.openFile('h.mp4');
    const closed = open.close();
    await open.checkpoint();
    await closed;
    expect(writable.close).toHaveBeenCalledOnce();
    expect(createWritable).toHaveBeenCalledOnce();
  });

  it('two close() calls at the same moment close the stream once and both resolve', async () => {
    // Removal that must fail this test: the shared promise, so each call
    // reaches the stream's own close.
    let closes = 0;
    const writable = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockImplementation(async () => {
        closes++;
        await new Promise((r) => setTimeout(r, 10));
        if (closes > 1) throw new TypeError('Cannot close a closed or closing stream');
      }),
    };
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'h.mp4' };
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue(handle) });
    await fw.openFile('h.mp4');

    const results = await Promise.allSettled([fw.close(), fw.close()]);
    await expect(fw.close()).resolves.toBeUndefined();

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(writable.close).toHaveBeenCalledOnce();
  });

  it('two close() calls on a stream whose close fails both reject with that error', async () => {
    const writable = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockRejectedValue(new Error('disk full')),
    };
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'h.mp4' };
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue(handle) });
    await fw.openFile('h.mp4');

    const results = await Promise.allSettled([fw.close(), fw.close()]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(results.map((r) => (r as PromiseRejectedResult).reason.message)).toEqual(['disk full', 'disk full']);
    expect(writable.close).toHaveBeenCalledOnce();
  });

  it('close() on a file that was never opened resolves', async () => {
    await expect(new FileWriter({ picker: vi.fn() }).close()).resolves.toBeUndefined();
  });

  it('a write after close rejects', async () => {
    const writable = fakeWritable();
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'h.mp4' };
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue(handle) });
    await fw.openFile('h.mp4');
    await fw.close();
    await expect(fw.write(0, new ArrayBuffer(1))).rejects.toThrow();
    expect(writable.write).not.toHaveBeenCalled();
  });

  it('write before open throws', async () => {
    const fw = new FileWriter({ picker: vi.fn() });
    await expect(fw.write(0, new ArrayBuffer(1))).rejects.toThrow();
  });

  it('isFsAccessSupported tracks showDirectoryPicker, the entry point the host uses', () => {
    // The host writes TWO files from one click. showSaveFilePicker consumes the
    // click's transient activation, so the second call is rejected; the host
    // path opens a directory once instead. Gating on showSaveFilePicker would
    // therefore report "supported" on a browser that cannot complete the flow.
    const orig = (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = () => {};
    expect(isFsAccessSupported()).toBe(true);
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    expect(isFsAccessSupported()).toBe(false);
    if (orig) (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = orig;
  });

  it('openIn writes both files into one directory without prompting again', async () => {
    const writables = [fakeWritable(), fakeWritable()];
    const getFileHandle = vi
      .fn()
      .mockImplementation((name: string) =>
        Promise.resolve({ name, createWritable: vi.fn().mockResolvedValue(writables[getFileHandle.mock.calls.length - 1]) })
      );
    const dir = { getFileHandle };

    const host = new FileWriter();
    await host.openIn(dir, 'host_abc.mp4');
    const guest = new FileWriter();
    await guest.openIn(dir, 'guest_abc.mp4');

    expect(host.fileName).toBe('host_abc.mp4');
    expect(guest.fileName).toBe('guest_abc.mp4');
    expect(getFileHandle).toHaveBeenCalledTimes(2);
    expect(getFileHandle).toHaveBeenCalledWith('host_abc.mp4', { create: true });
    expect(getFileHandle).toHaveBeenCalledWith('guest_abc.mp4', { create: true });
  });

  it('maps QuotaExceededError to DiskFullError', async () => {
    const { DiskFullError } = await import('@/lib/fs-writer');
    const writable = {
      write: vi.fn().mockRejectedValue(Object.assign(new Error('full'), { name: 'QuotaExceededError' })),
      close: vi.fn(),
    };
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'h.mp4' };
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue(handle) });
    await fw.openFile('h.mp4');
    await expect(fw.write(0, new ArrayBuffer(4))).rejects.toBeInstanceOf(DiskFullError);
  });

  it('tracks size as the furthest byte reached and does not decrease on write at position 0', async () => {
    const writable = fakeWritable();
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'test.mp4' };
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue(handle) });
    await fw.openFile('test.mp4');

    await fw.write(0, new Uint8Array(10));
    await fw.write(100, new Uint8Array(10));
    await fw.write(0, new Uint8Array(4));
    expect(fw.size).toBe(110);
  });

  it('accepts a Blob and still tracks the furthest byte', async () => {
    // Removal that must fail this test: computing end from data.byteLength,
    // which is undefined for a Blob.
    const writable = fakeWritable();
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'guest.mp4' };
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue(handle) });
    await fw.openFile('guest.mp4');

    const blob = new Blob([new Uint8Array(10)]);
    await fw.write(5, blob);

    expect(writable.write).toHaveBeenCalledWith({ type: 'write', position: 5, data: blob });
    expect(fw.size).toBe(15);
  });

  it('does not move size on rejected write, still rejects to caller, and subsequent write lands', async () => {
    const writable = {
      write: vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const handle = { createWritable: vi.fn().mockResolvedValue(writable), name: 'err.mp4' };
    const fw = new FileWriter({ picker: vi.fn().mockResolvedValue(handle) });
    await fw.openFile('err.mp4');

    await expect(fw.write(0, new Uint8Array(10))).rejects.toThrow('x');
    expect(fw.size).toBe(0);

    await fw.write(0, new Uint8Array(6));
    expect(fw.size).toBe(6);
  });
});

describe('writeTakeSidecars', () => {
  it('writes expected names and contents, skips empty content, and returns true', async () => {
    const writtenFiles = new Map<string, { data: Uint8Array; closed: boolean }>();
    const dir = {
      getFileHandle: vi.fn().mockImplementation((name: string) => {
        let writtenData: Uint8Array = new Uint8Array(0);
        let closed = false;
        const writable = {
          write: vi.fn().mockImplementation(({ position, data }: { position: number; data: Uint8Array }) => {
            writtenData = data;
            return Promise.resolve();
          }),
          close: vi.fn().mockImplementation(() => {
            closed = true;
            writtenFiles.set(name, { data: writtenData, closed });
            return Promise.resolve();
          }),
        };
        return Promise.resolve({ name, createWritable: vi.fn().mockResolvedValue(writable) });
      }),
    };

    const ok = await writeTakeSidecars(dir, [
      { name: 'sync_abc.json', content: '{"ok":true}' },
      { name: 'chapters_abc.txt', content: '' },
      { name: 'chat_abc.txt', content: '[0:00] Ana: hi\n' },
    ]);

    expect(ok).toBe(true);
    expect(dir.getFileHandle).toHaveBeenCalledTimes(2);
    expect(dir.getFileHandle).toHaveBeenCalledWith('sync_abc.json', { create: true });
    expect(dir.getFileHandle).toHaveBeenCalledWith('chat_abc.txt', { create: true });
    expect(new TextDecoder().decode(writtenFiles.get('sync_abc.json')?.data)).toBe('{"ok":true}');
    expect(writtenFiles.get('sync_abc.json')?.closed).toBe(true);
    expect(new TextDecoder().decode(writtenFiles.get('chat_abc.txt')?.data)).toBe('[0:00] Ana: hi\n');
    expect(writtenFiles.get('chat_abc.txt')?.closed).toBe(true);
  });

  it('returns false without throwing when createWritable rejects', async () => {
    const dir = {
      getFileHandle: vi.fn().mockResolvedValue({
        name: 'sync_abc.json',
        createWritable: vi.fn().mockRejectedValue(new Error('permission denied')),
      }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ok = await writeTakeSidecars(dir, [{ name: 'sync_abc.json', content: '{}' }]);

    expect(ok).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns false without throwing when write rejects', async () => {
    const dir = {
      getFileHandle: vi.fn().mockResolvedValue({
        name: 'sync_abc.json',
        createWritable: vi.fn().mockResolvedValue({
          write: vi.fn().mockRejectedValue(new Error('disk write error')),
          close: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ok = await writeTakeSidecars(dir, [{ name: 'sync_abc.json', content: '{}' }]);

    expect(ok).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('pickRecordingDirectory', () => {
  // The first file of a take can be created long after the click that chose
  // the folder, when the browser would refuse a second question.
  it('asks for write access together with the folder', async () => {
    const dir = { getFileHandle: vi.fn() };
    const picker = vi.fn().mockResolvedValue(dir);
    await expect(pickRecordingDirectory(picker)).resolves.toBe(dir);
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
  });
});

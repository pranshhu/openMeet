import { describe, it, expect, vi } from 'vitest';
import { FileWriter, isFsAccessSupported } from '@/lib/fs-writer';
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

import { describe, it, expect, vi } from 'vitest';
import { FileWriter, isFsAccessSupported } from '@/lib/fs-writer';

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
});

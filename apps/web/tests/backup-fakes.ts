import type { FsDirectoryHandle } from '@/lib/fs-writer';
import { ChunkSender } from '@/lib/chunk-sender';

export interface FakeFolderFile {
  bytes: Uint8Array;
  closed: boolean;
}

export interface FakeFolderHandle extends FsDirectoryHandle {
  files: Map<string, FakeFolderFile>;
  calls: Array<{ name: string; create: boolean }>;
  removed: string[];
  removeEntry(name: string): Promise<void>;
}

export function fakeFolder(opts?: {
  refuseCreate?: boolean;
  lateWrites?: boolean;
  fullDisk?: boolean;
  closeFails?: boolean;
}): FakeFolderHandle {
  const files = new Map<string, FakeFolderFile>();
  const calls: Array<{ name: string; create: boolean }> = [];
  const removed: string[] = [];

  const handle: FakeFolderHandle = {
    files,
    calls,
    removed,
    async getFileHandle(name: string, o?: { create?: boolean }) {
      const create = Boolean(o?.create);
      calls.push({ name, create });
      if (create) {
        if (opts?.refuseCreate) {
          const err = new Error('Permission denied');
          err.name = 'NotAllowedError';
          throw err;
        }
        if (!files.has(name)) {
          files.set(name, { bytes: new Uint8Array(0), closed: false });
        }
      } else {
        if (!files.has(name)) {
          const err = new Error(`File not found: ${name}`);
          err.name = 'NotFoundError';
          throw err;
        }
      }

      return {
        name,
        async createWritable() {
          const fileEntry = files.get(name);
          if (fileEntry) {
            fileEntry.bytes = new Uint8Array(0);
            fileEntry.closed = false;
          }
          return {
            async write(d: { type?: 'write'; position: number; data: ArrayBuffer | ArrayBufferView | Blob }) {
              // A real writable settles off the current task, so a receiver that
              // reads its own state right after calling write() sees it stale.
              if (opts?.lateWrites) await new Promise((r) => setTimeout(r, 0));
              if (opts?.fullDisk) {
                const err = new Error('Quota exceeded');
                err.name = 'QuotaExceededError';
                throw err;
              }
              const fileEntry = files.get(name);
              if (!fileEntry) throw new Error('File removed');
              const src =
                d.data instanceof Blob
                  ? new Uint8Array(await d.data.arrayBuffer())
                  : d.data instanceof Uint8Array
                  ? d.data
                  : ArrayBuffer.isView(d.data)
                  ? new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.byteLength)
                  : new Uint8Array(d.data);
              const end = d.position + src.byteLength;
              if (fileEntry.bytes.length < end) {
                const next = new Uint8Array(end);
                next.set(fileEntry.bytes);
                fileEntry.bytes = next;
              }
              fileEntry.bytes.set(src, d.position);
            },
            async close() {
              // Commit often fails on a disk that filled up while writing.
              if (opts?.closeFails) {
                const err = new Error('Quota exceeded');
                err.name = 'QuotaExceededError';
                throw err;
              }
              const fileEntry = files.get(name);
              if (fileEntry) fileEntry.closed = true;
            },
          };
        },
      };
    },
    async removeEntry(name: string) {
      removed.push(name);
      files.delete(name);
    },
  };

  return handle;
}

export interface FakeChannel {
  label: string;
  readyState: 'open' | 'closed' | 'connecting' | 'closing';
  binaryType: string;
  bufferedAmount: number;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onopen: (() => void) | null;
  onbufferedamountlow: (() => void) | null;
  sent: (string | ArrayBuffer)[];
  send(data: string | ArrayBuffer): void;
  close(): void;
  deliver(data: unknown): void;
}

export function fakeChannel(label = ''): RTCDataChannel & FakeChannel {
  const ch: FakeChannel = {
    label,
    readyState: 'open',
    binaryType: '',
    bufferedAmount: 0,
    onmessage: null,
    onclose: null,
    onopen: null,
    onbufferedamountlow: null,
    sent: [],
    send(data: string | ArrayBuffer) {
      if (ch.readyState !== 'open') throw new Error('DataChannel is not open');
      ch.sent.push(data);
    },
    close() {
      if (ch.readyState === 'closed') return;
      ch.readyState = 'closed';
      ch.onclose?.();
    },
    deliver(data: unknown) {
      ch.onmessage?.({ data });
    },
  };

  return ch as unknown as RTCDataChannel & FakeChannel;
}

export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** What a real ChunkSender puts on the wire for one recorded chunk, plus its digest. */
export async function framesFor(
  bytes: Uint8Array
): Promise<{ frames: (string | ArrayBuffer)[]; sha256: string }> {
  const frames: (string | ArrayBuffer)[] = [];
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(data: string | ArrayBuffer) {
      frames.push(data);
    },
  } as unknown as RTCDataChannel;
  const sender = new ChunkSender({ recordingId: 'backup', channel });
  sender.sendChunk({
    header: { idx: 0, offset: 0, size: bytes.byteLength, ts: 1 },
    payload: bytes.slice().buffer,
  });
  return { frames, sha256: await sender.digestHex() };
}

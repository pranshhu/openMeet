import type { FsDirectoryHandle } from '@/lib/fs-writer';

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

export function fakeFolder(opts?: { refuseCreate?: boolean }): FakeFolderHandle {
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
            async write(d: { type?: 'write'; position: number; data: ArrayBuffer | ArrayBufferView }) {
              const fileEntry = files.get(name);
              if (!fileEntry) throw new Error('File removed');
              const src =
                d.data instanceof Uint8Array
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

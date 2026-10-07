/** Minimal in-memory OPFS handles, shared by the tests that exercise browser storage. */

// jsdom's Blob has no arrayBuffer(), which FakeFileHandle needs to read a write back.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

export class FakeFileHandle {
  readonly kind = 'file' as const;
  constructor(
    public name: string,
    public content: Uint8Array = new Uint8Array(),
    public lastModified: number = Date.now(),
  ) {}

  async createWritable() {
    let buffer = new Uint8Array();
    return {
      write: async (data: Blob | BufferSource) => {
        let bytes: Uint8Array;
        if (data && typeof (data as Blob).arrayBuffer === 'function') {
          const ab = await (data as Blob).arrayBuffer();
          bytes = new Uint8Array(ab);
        } else if (data instanceof ArrayBuffer) {
          bytes = new Uint8Array(data);
        } else if (ArrayBuffer.isView(data)) {
          bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else {
          bytes = new Uint8Array();
        }
        const next = new Uint8Array(buffer.length + bytes.length);
        next.set(buffer, 0);
        next.set(bytes, buffer.length);
        buffer = next;
      },
      close: async () => {
        this.content = buffer;
        this.lastModified = Date.now();
      },
    };
  }

  async getFile(): Promise<File> {
    return new File([this.content as BlobPart], this.name, { lastModified: this.lastModified });
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory' as const;
  entries = new Map<string, FakeFileHandle | FakeDirectoryHandle>();

  constructor(public name: string = '') {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    let existing = this.entries.get(name);
    if (!existing) {
      if (!opts?.create) {
        const err = new Error('not found');
        err.name = 'NotFoundError';
        throw err;
      }
      existing = new FakeDirectoryHandle(name);
      this.entries.set(name, existing);
    }
    if (existing.kind !== 'directory') {
      const err = new Error('TypeMismatchError');
      err.name = 'TypeMismatchError';
      throw err;
    }
    return existing as FakeDirectoryHandle;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let existing = this.entries.get(name);
    if (!existing) {
      if (!opts?.create) {
        const err = new Error('not found');
        err.name = 'NotFoundError';
        throw err;
      }
      existing = new FakeFileHandle(name);
      this.entries.set(name, existing);
    }
    if (existing.kind !== 'file') {
      const err = new Error('TypeMismatchError');
      err.name = 'TypeMismatchError';
      throw err;
    }
    return existing as FakeFileHandle;
  }

  async removeEntry(name: string, _opts?: { recursive?: boolean }): Promise<void> {
    const existing = this.entries.get(name);
    if (!existing) {
      const err = new Error('not found');
      err.name = 'NotFoundError';
      throw err;
    }
    this.entries.delete(name);
  }

  async *values() {
    for (const entry of this.entries.values()) {
      yield entry;
    }
  }

  async *[Symbol.asyncIterator]() {
    for (const entry of this.entries.values()) {
      yield entry;
    }
  }
}

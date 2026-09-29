import { GUEST_RETRANSMIT_BUFFER_CAP } from '@openmeet/protocol';
import type { RecordedChunk } from './recorder';

export class RetransmitBuffer {
  private readonly cap: number;
  private items: RecordedChunk[] = [];
  private _bytes = 0;

  constructor(cap: number = GUEST_RETRANSMIT_BUFFER_CAP) {
    this.cap = cap;
  }

  get bytes(): number {
    return this._bytes;
  }

  add(chunk: RecordedChunk): void {
    this.items.push(chunk);
    this._bytes += chunk.header.size;
  }

  truncate(uptoIdx: number): void {
    let removed = 0;
    while (this.items.length > 0 && this.items[0]!.header.idx <= uptoIdx) {
      removed += this.items.shift()!.header.size;
    }
    this._bytes -= removed;
  }

  since(idx: number): RecordedChunk[] {
    return this.items.filter((c) => c.header.idx > idx);
  }
}

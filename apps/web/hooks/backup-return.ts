import {
  DC_BUFFERED_HIGH_WATERMARK,
  DC_BUFFERED_LOW_WATERMARK,
  DC_MAX_MESSAGE_BYTES,
  recordingChannelKind,
  type ChunkAck,
} from '@openmeet/protocol';
import { integrityVerdict, sanitizeText } from '@/lib/sync-report';
import { parseBackupName, type BackupName } from '@/lib/backup-recorder';
import { ChunkReceiver } from '@/lib/chunk-receiver';
import { ChunkSender } from '@/lib/chunk-sender';
import { DiskFullError, FileWriter, type FsDirectoryHandle } from '@/lib/fs-writer';
import { writeTakeSidecars } from './recording-controller';

/** One backup on its way from a guest to the host, as either side shows it. */
export interface BackupTransfer {
  /** The backup's file name on the sender's device: unique per backup. */
  id: string;
  kind: BackupName['kind'];
  size: number;
  /** offered: waiting for the host. stalled: the connection dropped part-way. */
  status: 'offered' | 'active' | 'stalled' | 'saved' | 'failed';
  /** A whole number, so progress is at most a hundred renders per file. */
  percent: number;
  /** Host only: who is sending it. */
  from?: string;
  /** Host only: it failed because the disk filled up. */
  diskFull?: boolean;
}

/** The name a returned backup gets in the host's recording folder. */
export function returnedBackupName(backup: BackupName, from: string | null): string {
  let who = (from ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  who = [...who].slice(0, 40).join('');
  if (!who) who = 'guest';
  const stamp = new Date(backup.startedMs).toISOString().replace(/[-:.]/g, '');
  return `backup_${who}_${backup.kind}_${stamp}.${backup.ext}`;
}

/** The JSON note written beside a verified returned backup. */
export function buildBackupNote(note: {
  file: string; // its name in the host's folder
  backupOf: string; // its name on the sender's device
  backup: BackupName;
  from: string;
  sizeBytes: number;
  sha256Sent: string;
  sha256Written: string;
}): string {
  const fromClean = [...sanitizeText(note.from).trim()].slice(0, 64).join('');
  const alignment =
    note.backup.kind === 'screen'
      ? "This is the sharer's backup of one screen segment. It holds the same recording as the live segment, so that segment's offset in the take's sync file applies when the segment is listed there."
      : "This is the participant's own backup copy, from a separate recorder that started at its own instant. The offsets in the take's sync file do not apply to it: align it by audio waveform.";

  const obj = {
    file: note.file,
    backupOf: note.backupOf,
    kind: note.backup.kind,
    room: note.backup.room,
    from: fromClean,
    sizeBytes: note.sizeBytes,
    sha256: note.sha256Written,
    integrity: integrityVerdict(note.sha256Sent, note.sha256Written).text,
    startedUnixMs: note.backup.startedMs,
    startedUnixMsNote:
      "Read from the sender's device clock, not measured against the host's. Compare it with timeline.hostStartUnixMs in a take's sync file to tell which take this belongs to.",
    alignment,
    generatedBy: 'openMeet',
  };

  return JSON.stringify(obj, null, 2);
}

/** Offers one participant may have waiting for the host's answer at a time. */
export const MAX_BACKUP_OFFERS_PER_PEER = 8;

function say(channel: RTCDataChannel, json: string): void {
  if (channel.readyState !== 'open') return;
  try {
    channel.send(json);
  } catch {
    // Channel closed or broke between ready check and send.
  }
}

// "This tab holds none of it" — the answer to an offer this tab will not take
// and to a resume query for a transfer it does not have.
const NO_COPY = JSON.stringify({
  type: 'recording-finalized',
  recordingId: '',
  totalBytes: 0,
  sha256: '',
});

function turnAway(channel: RTCDataChannel): void {
  say(channel, NO_COPY);
  try {
    channel.close();
  } catch {
    // Channel already closed.
  }
}

// Returns the parsed control message when data is a string containing "type".
// A chunk header never contains a "type" key, so this runs for every 64 KiB
// fragment but parses only control frames.
function control(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string' || !data.includes('"type"')) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Plain text or corrupted frame.
  }
  return null;
}

/** Tell a sender this tab will not take its backup, so it stops waiting. */
export function refuseBackup(channel: RTCDataChannel): void {
  channel.onmessage = () => turnAway(channel);
}

interface BackupRecord {
  item: BackupTransfer;
  backup: BackupName;
  peerId: string;
  channel: RTCDataChannel;
  key: string;
  dir?: FsDirectoryHandle | undefined;
  file?: string | undefined;
  writer?: FileWriter | undefined;
  receiver?: ChunkReceiver | undefined;
  /** A finalize is running: the file is being closed and checked. */
  closing: boolean;
  /** The verdict already sent, so a sender that asks again gets it again. */
  verdict?: string | undefined;
  /** Every write routed so far: a resume answer must not name an offset short of the file. */
  pending: Promise<void>;
}

// A guest's backup is never deleted automatically, so it comes back, and
// opening a name that exists would replace a file the host already has.
async function freeName(dir: FsDirectoryHandle, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? '' : name.slice(dot);
  for (let i = 1; i <= 99; i++) {
    const candidate = i === 1 ? name : `${stem}_${i}${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFoundError') return candidate;
      throw e;
    }
  }
  throw new Error('Too many copies of this backup in the folder.');
}

/** Host side: every backup offered to this tab, from the offer to the verdict. */
export class BackupIntake {
  private readonly room: string;
  private readonly onChange: (items: BackupTransfer[]) => void;
  private readonly records = new Map<string, BackupRecord>();
  // The tail of the file-opening work of every Save so far: one Save's probes
  // must finish before the next one chooses names.
  private opening: Promise<void> = Promise.resolve();

  constructor(opts: { room: string; onChange: (items: BackupTransfer[]) => void }) {
    this.room = opts.room;
    this.onChange = opts.onChange;
  }

  private emit(): void {
    this.onChange(Array.from(this.records.values(), (r) => r.item));
  }

  /** A `backup#<name>` channel arrived from a participant. */
  offer(channel: RTCDataChannel, from: { peerId: string; name: string | null }): void {
    const id = recordingChannelKind(channel.label).key ?? '';
    const backup = parseBackupName(id);
    if (!backup || backup.room !== this.room) {
      refuseBackup(channel);
      return;
    }

    channel.binaryType = 'arraybuffer';
    channel.onmessage = (ev: { data: unknown }) => {
      void this.onMessage(id, backup, channel, from, ev.data).catch(() => {});
    };
    channel.onclose = () => this.onClose(id, channel);
  }

  private async onMessage(
    id: string,
    backup: BackupName,
    channel: RTCDataChannel,
    from: { peerId: string; name: string | null },
    data: unknown
  ): Promise<void> {
    const msg = control(data);
    if (msg?.type === 'backup_offer') {
      await this.handleOffer(id, backup, channel, from, msg.size, msg.key);
      return;
    }
    if (msg?.type === 'resume_query') {
      const record = this.records.get(id);
      if (!record?.receiver) {
        // This tab holds none of this backup: frames on this channel are gone.
        say(channel, NO_COPY);
        return;
      }
      // Only the sender that created the record may move it: a channel that
      // merely guesses the label would otherwise take over the transfer.
      if (msg.key !== record.key) {
        turnAway(channel);
        return;
      }
      if (record.channel !== channel) {
        // The same backup on a rebuilt connection. Move it before the old
        // channel closes, so its close event is not read as this record's.
        const previous = record.channel;
        record.channel = channel;
        turnAway(previous);
      }
      // The receiver hashes and counts a chunk only after its write resolves,
      // so with writes queued it would report an offset short of the bytes on
      // disk and refuse the sender's honest next chunk as out of order.
      await record.pending;
      // Fall through: the receiver answers with where it actually stands.
    }

    const record = this.records.get(id);
    const receiver = record?.receiver;
    if (!record || !receiver || record.channel !== channel) return;
    const handled = receiver.handleMessage(data as string | ArrayBuffer);
    // Not just this message's write: one that returned without writing must
    // not make a later resume answer look settled while an earlier write runs.
    record.pending = Promise.all([record.pending, handled]).then(
      () => undefined,
      () => undefined
    );
    await handled;
    if (record.receiver !== receiver) return;

    if (record.verdict) {
      // Saved: a sender that asked again because the first answer died with
      // its connection gets the verdict, not a resume offset.
      say(record.channel, record.verdict);
      return;
    }
    if (receiver.isAbandoned) {
      await this.failRecord(record);
      return;
    }
    if (receiver.receivedFinalized) {
      await this.finish(record, receiver);
      return;
    }
    const percent = Math.min(99, Math.floor((receiver.bytesWritten * 100) / record.item.size));
    // A write that was queued before the connection dropped settles after
    // `stalled` was shown: it may move the percent, never the status.
    const status = record.channel.readyState === 'open' ? 'active' : record.item.status;
    if (percent !== record.item.percent || status !== record.item.status) {
      record.item = { ...record.item, status, percent };
      this.emit();
    }
  }

  /** The sender says everything it sent has arrived: close, verify, and say what was saved. */
  private async finish(record: BackupRecord, receiver: ChunkReceiver): Promise<void> {
    if (record.closing) return;
    record.closing = true;
    try {
      await record.writer?.close();
    } catch (e) {
      record.closing = false;
      await this.failRecord(record, e);
      return;
    }
    // Both are final only once every queued write has finished: the receiver
    // hashes and counts a chunk after its write resolves, never before.
    const written = await receiver.digestHex();
    // The sender may have given up while the file was closing: the record was
    // failed and its receiver dropped, and its verdict is no longer this one's.
    if (record.receiver !== receiver) return;
    if (receiver.bytesWritten !== record.item.size || receiver.senderSha256 !== written) {
      await this.failRecord(record);
      return;
    }

    const id = record.item.id;
    const file = record.file ?? receiver.fileName;
    let content = '';
    try {
      content = buildBackupNote({
        file,
        backupOf: id,
        backup: record.backup,
        from: record.item.from ?? 'Guest',
        sizeBytes: receiver.bytesWritten,
        sha256Sent: receiver.senderSha256 ?? '',
        sha256Written: written,
      });
    } catch {
      // A note that cannot be built must not fail a verified backup.
    }
    if (record.dir) {
      await writeTakeSidecars(record.dir, [{ name: file.replace(/\.[^.]+$/, '.json'), content }]);
    }

    // The file is closed; the receiver stays so a later resume_query is answered.
    record.writer = undefined;
    const verdict = JSON.stringify({
      type: 'recording-finalized',
      recordingId: id,
      totalBytes: receiver.bytesWritten,
      sha256: written,
    });
    record.verdict = verdict;
    say(record.channel, verdict);
    record.item = { ...record.item, status: 'saved', percent: 100 };
    this.emit();
  }

  private async handleOffer(
    id: string,
    backup: BackupName,
    channel: RTCDataChannel,
    from: { peerId: string; name: string | null },
    size: unknown,
    key: unknown
  ): Promise<void> {
    if (!Number.isSafeInteger(size) || (size as number) <= 0) {
      turnAway(channel);
      return;
    }
    if (typeof key !== 'string' || key.length < 1 || key.length > 64) {
      turnAway(channel);
      return;
    }

    const old = this.records.get(id);
    // Another key may only take a name that holds nothing: a waiting offer whose channel is
    // gone. An accepted backup has a file on the host's disk, and only the key that created
    // it may restart it.
    if (old && old.key !== key && (old.item.status !== 'offered' || old.channel.readyState === 'open')) {
      turnAway(channel);
      return;
    }

    const clean = sanitizeText(from.name ?? '').trim();
    const hasVisible = /[^\p{Cf}\p{Z}\p{Cc}]/u.test(clean);
    const who = hasVisible ? [...clean].slice(0, 64).join('') : 'Guest';

    let waitingCount = 0;
    for (const r of this.records.values()) {
      if (r !== old && r.peerId === from.peerId && r.item.status === 'offered') {
        waitingCount++;
      }
    }
    if (waitingCount >= MAX_BACKUP_OFFERS_PER_PEER) {
      turnAway(channel);
      return;
    }

    if (old && old.item.status === 'offered') {
      const previous = old.channel;
      // The sender repeats an offer on the connection that already holds it:
      // the host has read that size and name, so neither may change under it.
      if (previous === channel) return;
      old.channel = channel;
      old.peerId = from.peerId;
      old.key = key;
      old.item = { ...old.item, size: size as number, from: who };
      this.emit();
      turnAway(previous);
      return;
    }

    const item: BackupTransfer = {
      id,
      kind: backup.kind,
      size: size as number,
      status: 'offered',
      percent: 0,
      from: who,
    };
    const newRecord: BackupRecord = {
      item,
      backup,
      peerId: from.peerId,
      channel,
      key,
      closing: false,
      pending: Promise.resolve(),
    };
    this.records.set(id, newRecord);
    this.emit();

    if (old) {
      if (old.channel !== channel) {
        turnAway(old.channel);
      }
      await this.endRecordFile(old);
    }
  }

  /** The host said yes to the offers it was shown: open a file for each. Never throws. */
  async accept(dir: FsDirectoryHandle, shown: readonly BackupTransfer[]): Promise<void> {
    const waiting: BackupRecord[] = [];
    for (const record of this.records.values()) {
      if (record.item.status === 'offered' && shown.includes(record.item)) {
        record.item = { ...record.item, status: 'active' };
        waiting.push(record);
      }
    }
    if (waiting.length === 0) return;
    this.emit();

    // One Save's files open one after another. A second Save that lands while
    // this one is still probing names would pick the same free name, and the
    // record it replaces would remove the file the other just opened.
    this.opening = this.opening.then(() => this.open(waiting, dir));
    await this.opening;
  }

  private async open(waiting: BackupRecord[], dir: FsDirectoryHandle): Promise<void> {
    for (const record of waiting) {
      // A new offer for the same backup replaces its record in the map. The
      // replaced record must not get a file or a "go" for the host's yes.
      if (this.records.get(record.item.id) !== record) continue;
      try {
        const candidate = returnedBackupName(record.backup, record.item.from ?? null);
        const name = await freeName(dir, candidate);
        const writer = new FileWriter();
        try {
          await writer.openIn(dir, name);
        } catch (e) {
          // openIn creates the file before it opens a writable, so a folder
          // that refuses the writable would keep an empty file the host never
          // asked for.
          await dir.removeEntry?.(name).catch(() => {});
          throw e;
        }
        record.dir = dir;
        record.file = writer.fileName;
        record.writer = writer;
        if (this.records.get(record.item.id) !== record) {
          await this.endRecordFile(record);
          continue;
        }
        const receiver = new ChunkReceiver({
          recordingId: record.item.id,
          writer,
          maxBytes: record.item.size,
          // Reads the record each time, so replies follow a replaced channel.
          sendControl: (json) => say(record.channel, json),
          onError: (e) => {
            if (record.receiver === receiver) void this.failRecord(record, e);
          },
        });
        record.receiver = receiver;
        say(
          record.channel,
          JSON.stringify({
            type: 'resume_offset',
            recordingId: record.item.id,
            lastByte: 0,
            lastIdx: -1,
          })
        );
      } catch {
        // The failure is not this accept's to answer when a new offer replaced
        // the record: its channel now says the sender started over.
        if (this.records.get(record.item.id) !== record) {
          await this.endRecordFile(record);
          continue;
        }
        await this.failRecord(record);
      }
    }
  }

  private async failRecord(record: BackupRecord, error?: unknown): Promise<void> {
    if (record.item.status === 'saved' || record.item.status === 'failed') return;
    record.item =
      error instanceof DiskFullError
        ? { ...record.item, status: 'failed', diskFull: true }
        : { ...record.item, status: 'failed' };
    this.emit();
    turnAway(record.channel);
    await this.endRecordFile(record);
  }

  private async endRecordFile(record: BackupRecord): Promise<void> {
    const writer = record.writer;
    const dir = record.dir;
    const file = record.file;
    record.writer = undefined;
    record.dir = undefined;
    record.file = undefined;
    record.receiver = undefined;
    await writer?.close().catch(() => {});
    // The bytes that reached the file decide, not the receiver's count: a
    // receiver that refuses stops counting writes that were already queued.
    const arrived = writer?.size ?? 0;
    // A transfer that wrote nothing leaves an empty file nobody asked for; a
    // partial one is kept, and only a verified one gets a note.
    if (writer && file && dir?.removeEntry && arrived === 0) {
      await dir.removeEntry(file).catch(() => {});
    }
  }

  private onClose(id: string, channel: RTCDataChannel): void {
    const record = this.records.get(id);
    if (!record || record.channel !== channel) return;
    if (record.item.status === 'offered') {
      this.records.delete(id);
      this.emit();
      return;
    }
    if (record.item.status === 'active' && !record.closing) {
      record.item = { ...record.item, status: 'stalled' };
      this.emit();
    }
  }

  /** The host turned the waiting offers down: answer and drop each. */
  decline(): void {
    for (const [id, record] of this.records) {
      if (record.item.status === 'offered') {
        this.records.delete(id);
        turnAway(record.channel);
      }
    }
    this.emit();
  }

  /** Leaving the room: close every open file. */
  async close(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.records.values(), (r) =>
        // A record mid-finalize owns its file: finish() closes and checks it.
        r.closing ? r.writer?.close() : this.endRecordFile(r)
      )
    );
  }
}

/** How much of the file is read and handed to the sender at a time. */
export const BACKUP_READ_BYTES = 1024 * 1024;

// How often a waiting send looks again.
const POLL_MS = 200;

/** Guest side: one leftover backup on its way to the host. */
export class BackupSend {
  private readonly opts: { file: File; onChange?: (() => void) | undefined };
  // One key per item, kept for as long as the item lives: it is what lets the
  // host read a repeated offer on a rebuilt connection as the same sender, and
  // what turns another participant's offer for the same name away.
  private readonly key = crypto.randomUUID();
  private current: BackupTransfer;
  private sender: ChunkSender | null = null;
  private channel: RTCDataChannel | null = null;
  private paused = false;
  private started = false;
  private finished = false;
  private settleDone: (result: 'saved' | 'failed') => void = () => {};
  readonly done: Promise<'saved' | 'failed'>;

  constructor(opts: { file: File; onChange?: () => void }) {
    this.opts = opts;
    this.current = {
      id: opts.file.name,
      kind: parseBackupName(opts.file.name)?.kind ?? 'camera',
      size: opts.file.size,
      status: 'offered',
      percent: 0,
    };
    this.done = new Promise((resolve) => {
      this.settleDone = resolve;
    });
  }

  /** What to show for this send. A new object whenever it changes. */
  get item(): BackupTransfer {
    return this.current;
  }

  get settled(): boolean {
    return this.finished;
  }

  /** The channel to the host for this file. */
  attach(channel: RTCDataChannel): void {
    if (this.finished) {
      try {
        channel.close();
      } catch {
        // Already closed.
      }
      return;
    }
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    this.sender = new ChunkSender({
      recordingId: this.opts.file.name,
      channel,
      onBackpressure: (p) => {
        this.paused = p;
      },
      onAbandon: () => this.settle('failed'),
    });
    channel.bufferedAmountLowThreshold = DC_BUFFERED_LOW_WATERMARK;
    channel.onbufferedamountlow = () => this.sender?.drainQueue();
    channel.onmessage = (ev: { data: unknown }) => this.onControl(channel, ev.data);

    const offer = { type: 'backup_offer', size: this.opts.file.size, key: this.key };
    if (channel.readyState === 'open') this.say(offer);
    else channel.onopen = () => this.say(offer);
  }

  private say(msg: Record<string, unknown>): void {
    const channel = this.channel;
    if (channel?.readyState !== 'open') return;
    try {
      channel.send(JSON.stringify(msg));
    } catch {
      // Channel closed or broke between the ready check and the send.
    }
  }

  private set(patch: { status?: BackupTransfer['status']; percent?: number }): void {
    const status = patch.status ?? this.current.status;
    const percent = patch.percent ?? this.current.percent;
    if (status === this.current.status && percent === this.current.percent) return;
    this.current = { ...this.current, status, percent };
    this.opts.onChange?.();
  }

  private async wait(ready: () => boolean): Promise<void> {
    while (!this.finished && !ready()) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      // `bufferedamountlow` fires only on a crossing; this catches a queue it missed.
      this.sender?.drainQueue();
    }
  }

  // The host acks a chunk only once it is written, so this is what stops a slow
  // disk on the host from becoming unwritten buffers in its tab and, past
  // 256 MiB unacked, a stream this side abandons.
  private clear(): boolean {
    const sender = this.sender!;
    return (
      !this.paused &&
      (sender.lastSentIdx - sender.lastAckedIdx) * DC_MAX_MESSAGE_BYTES <= DC_BUFFERED_HIGH_WATERMARK
    );
  }

  private settle(result: 'saved' | 'failed'): void {
    if (this.finished) return;
    this.finished = true;
    this.set(result === 'saved' ? { status: 'saved', percent: 100 } : { status: 'failed' });
    if (result === 'failed') {
      this.say({
        type: 'stream-abandoned',
        recordingId: this.opts.file.name,
        lastIdx: this.sender?.lastSentIdx ?? -1,
      });
    }
    try {
      this.channel?.close();
    } catch {
      // Already closed.
    }
    this.settleDone(result);
  }

  private onControl(channel: RTCDataChannel, data: unknown): void {
    if (this.finished || typeof data !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === 'ack') {
      if (Number.isSafeInteger(msg.uptoIdx)) this.sender?.handleControl(msg as unknown as ChunkAck);
      return;
    }
    if (msg.type === 'resume_offset') {
      // The host's go-ahead, and the first one only: a second would start a
      // second read of the same file over the first.
      if (!Number.isSafeInteger(msg.lastIdx) || this.started) return;
      this.started = true;
      this.set({ status: 'active' });
      void this.run().catch(() => this.settle('failed'));
      return;
    }
    if (msg.type === 'recording-finalized') {
      void (async () => {
        const mine = await this.sender!.digestHex();
        this.settle(
          msg.sha256 === mine && msg.totalBytes === this.opts.file.size ? 'saved' : 'failed'
        );
      })().catch(() => this.settle('failed'));
    }
  }

  private async run(): Promise<void> {
    const { file } = this.opts;
    for (let at = 0; at < file.size; at += BACKUP_READ_BYTES) {
      const payload = await file.slice(at, at + BACKUP_READ_BYTES).arrayBuffer();
      await this.wait(() => this.clear());
      if (this.finished) return;
      this.sender!.sendChunk({ header: { idx: 0, offset: at, size: payload.byteLength, ts: 0 }, payload });
      this.set({ percent: Math.min(99, Math.floor(((at + payload.byteLength) * 100) / file.size)) });
    }
    const sha256 = await this.sender!.digestHex();
    // Ordered and reliable: sent after the last fragment, it arrives after it.
    await this.wait(() => !this.sender!.hasQueuedChunks);
    if (!this.finished) this.say({ type: 'recording-finalized', recordingId: file.name, totalBytes: file.size, sha256 });
  }

  cancel(): void {
    this.settle('failed');
  }
}

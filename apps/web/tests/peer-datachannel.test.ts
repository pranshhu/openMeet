import { describe, it, expect, vi } from 'vitest';
import { PeerConnection } from '@/lib/peer';
import {
  DATA_CHANNEL_BACKUP,
  DATA_CHANNEL_RECORDING,
  DATA_CHANNEL_RECORDING_AUDIO,
  DATA_CHANNEL_RECORDING_SCREEN,
} from '@openmeet/protocol';

class FakePC {
  ontrack: unknown = null;
  onicecandidate: unknown = null;
  onnegotiationneeded: unknown = null;
  ondatachannel: ((ev: { channel: unknown }) => void) | null = null;
  created: { label: string; opts: unknown }[] = [];
  addTrack() {}
  createDataChannel(label: string, opts?: unknown) {
    this.created.push({ label, opts });
    return new FakeChannel(label, opts) as unknown as RTCDataChannel;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
  signalingState = 'stable';
  localDescription = { sdp: '' };
}

type Listener = (ev: unknown) => void;

class FakeChannel {
  readyState = 'connecting';
  sent: string[] = [];
  throwOnSend = false;
  closed = false;
  private listeners = new Map<string, Listener[]>();
  constructor(readonly label: string, readonly opts?: unknown) {}
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string) {
    if (this.throwOnSend) throw new Error('closed');
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 'open';
    for (const fn of this.listeners.get('open') ?? []) fn({});
  }
  receive(data: unknown) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data });
  }
}

function make(opts: Record<string, unknown> = {}) {
  const pc = new FakePC();
  const peer = new PeerConnection({
    polite: true,
    iceServers: [],
    sendSignal: vi.fn(),
    onRemoteStream: vi.fn(),
    pcFactory: () => pc as unknown as RTCPeerConnection,
    ...opts,
  });
  return { peer, pc };
}

describe('PeerConnection recording DataChannel', () => {
  it('createRecordingChannel opens an ordered channel with the recording label', () => {
    const { peer, pc } = make();
    peer.start();
    const ch = peer.createRecordingChannel();
    expect((ch as unknown as { label: string }).label).toBe(DATA_CHANNEL_RECORDING);
    expect(pc.created[0]!.opts).toMatchObject({ ordered: true });
  });

  it('invokes onDataChannel when a recording channel arrives', () => {
    const onDataChannel = vi.fn();
    const { peer, pc } = make({ onDataChannel });
    peer.start();
    pc.ondatachannel!({ channel: { label: DATA_CHANNEL_RECORDING } });
    expect(onDataChannel).toHaveBeenCalledWith({ label: DATA_CHANNEL_RECORDING });
  });

  it('ignores non-recording channels', () => {
    const onDataChannel = vi.fn();
    const { peer, pc } = make({ onDataChannel });
    peer.start();
    pc.ondatachannel!({ channel: { label: 'other' } });
    expect(onDataChannel).not.toHaveBeenCalled();
  });

  it('ignores a remote control channel and does not forward it to onDataChannel', () => {
    const onDataChannel = vi.fn();
    const { peer, pc } = make({ onDataChannel });
    peer.start();
    pc.ondatachannel!({ channel: new FakeChannel('control') });
    expect(onDataChannel).not.toHaveBeenCalled();
  });

  it('createControlChannel creates a single data channel labelled control and is idempotent', () => {
    const { peer, pc } = make();
    peer.start();
    const ch1 = peer.createControlChannel();
    expect((ch1 as unknown as { label: string }).label).toBe('control');
    expect(pc.created).toHaveLength(1);
    expect(pc.created[0]!.label).toBe('control');
    expect(pc.created[0]!.opts).toMatchObject({ ordered: true });

    const ch2 = peer.createControlChannel();
    expect(ch2).toBe(ch1);
    expect(pc.created).toHaveLength(1);
  });

  it('createBackupChannel opens an ordered channel labelled backup#<name>', () => {
    const { peer, pc } = make();
    peer.start();
    const ch = peer.createBackupChannel('x.mp4');
    expect((ch as unknown as { label: string }).label).toBe(`${DATA_CHANNEL_BACKUP}#x.mp4`);
    expect(pc.created[0]!.opts).toMatchObject({ ordered: true });
  });

  it('createRecordingChannel(key) suffixes the label with #<key>', () => {
    const { peer } = make();
    peer.start();
    const ch = peer.createRecordingChannel('rec-123');
    expect((ch as unknown as { label: string }).label).toBe(`${DATA_CHANNEL_RECORDING}#rec-123`);
  });

  it('createRecordingScreenChannel(key) suffixes the label with #<key>, and with no key leaves it as numbered', () => {
    const { peer } = make();
    peer.start();
    const keyed = peer.createRecordingScreenChannel('k');
    expect((keyed as unknown as { label: string }).label).toBe(`${DATA_CHANNEL_RECORDING_SCREEN}-1#k`);

    const { peer: other } = make();
    other.start();
    const bare = other.createRecordingScreenChannel();
    expect((bare as unknown as { label: string }).label).toBe(`${DATA_CHANNEL_RECORDING_SCREEN}-1`);
  });

  it('accepts a keyed recording channel (recording#x) and a keyed audio channel (recording-audio#x)', () => {
    const onDataChannel = vi.fn();
    const { peer, pc } = make({ onDataChannel });
    peer.start();
    pc.ondatachannel!({ channel: { label: `${DATA_CHANNEL_RECORDING}#x` } });
    pc.ondatachannel!({ channel: { label: `${DATA_CHANNEL_RECORDING_AUDIO}#x` } });
    expect(onDataChannel).toHaveBeenCalledTimes(2);
  });

  it('forwards a returned backup channel, and still drops other and control channels', () => {
    const onDataChannel = vi.fn();
    const { peer, pc } = make({ onDataChannel });
    peer.start();
    pc.ondatachannel!({ channel: { label: `${DATA_CHANNEL_BACKUP}#x.mp4` } });
    pc.ondatachannel!({ channel: { label: 'other' } });
    pc.ondatachannel!({ channel: new FakeChannel('control') });
    expect(onDataChannel).toHaveBeenCalledTimes(1);
    expect(onDataChannel).toHaveBeenCalledWith({ label: `${DATA_CHANNEL_BACKUP}#x.mp4` });
  });
});

describe('PeerConnection control channel chat', () => {
  const received = (peer: PeerConnection, pc: FakePC) => {
    const channel = new FakeChannel('control');
    peer.start();
    pc.ondatachannel!({ channel });
    return channel;
  };
  const made = (peer: PeerConnection, pc: FakePC) => {
    peer.start();
    const created = peer.createControlChannel() as unknown as FakeChannel;
    return created;
  };
  const hello = JSON.stringify({ type: 'hello' });

  for (const [name, take] of [
    ['a received control channel', received],
    ['the control channel it created', made],
  ] as const) {
    describe(name, () => {
      it('sends the hello once when it opens', () => {
        const { peer, pc } = make();
        const channel = take(peer, pc);
        expect(channel.sent).toEqual([]);
        channel.open();
        expect(channel.sent).toEqual([hello]);
      });

      it('sends the hello at once when it is already open', () => {
        const { peer, pc } = make();
        peer.start();
        const channel = new FakeChannel('control');
        channel.readyState = 'open';
        if (take === received) pc.ondatachannel!({ channel });
        else {
          pc.createDataChannel = () => channel as unknown as RTCDataChannel;
          peer.createControlChannel();
        }
        expect(channel.sent).toEqual([hello]);
      });

      it('sends a line only after the far hello has arrived', () => {
        const { peer, pc } = make();
        const channel = take(peer, pc);
        channel.open();
        channel.sent.length = 0;
        expect(peer.sendChat('hi', false)).toBe(false);
        expect(channel.sent).toEqual([]);
        channel.receive(hello);
        expect(peer.sendChat('hi', false)).toBe(true);
        expect(peer.sendChat('psst', true)).toBe(true);
        expect(channel.sent).toEqual([
          JSON.stringify({ type: 'chat', text: 'hi' }),
          JSON.stringify({ type: 'chat', text: 'psst', private: true }),
        ]);
      });

      it('hands a chat frame to onChat and drops a bad one', () => {
        const onChat = vi.fn();
        const { peer, pc } = make({ onChat });
        const channel = take(peer, pc);
        channel.receive(JSON.stringify({ type: 'chat', text: 'hi' }));
        channel.receive(JSON.stringify({ type: 'chat', text: 'psst', private: true }));
        channel.receive('not json');
        channel.receive(new ArrayBuffer(4));
        channel.receive(JSON.stringify({ type: 'chat', text: 5 }));
        channel.receive(hello);
        expect(onChat.mock.calls).toEqual([
          [{ text: 'hi', private: false }],
          [{ text: 'psst', private: true }],
        ]);
      });
    });
  }

  it('never passes a control channel to onDataChannel', () => {
    const onDataChannel = vi.fn();
    const { peer, pc } = make({ onDataChannel });
    received(peer, pc);
    expect(onDataChannel).not.toHaveBeenCalled();
  });

  it('takes the control channel it created and one received, and sends on the created one', () => {
    const onChat = vi.fn();
    const { peer, pc } = make({ onChat });
    const first = made(peer, pc);
    const second = new FakeChannel('control');
    pc.ondatachannel!({ channel: second });
    first.open();
    second.open();
    expect(second.sent).toEqual([hello]);
    second.receive(hello);
    second.receive(JSON.stringify({ type: 'chat', text: 'from second' }));
    expect(onChat).toHaveBeenCalledWith({ text: 'from second', private: false });
    expect(peer.sendChat('hi', false)).toBe(true);
    expect(first.sent).toEqual([hello, JSON.stringify({ type: 'chat', text: 'hi' })]);
    expect(second.sent).toEqual([hello]);
  });

  it('closes a second received control channel and gives it no listener and no hello', () => {
    const onChat = vi.fn();
    const { peer, pc } = make({ onChat });
    peer.start();
    const first = new FakeChannel('control');
    const second = new FakeChannel('control');
    pc.ondatachannel!({ channel: first });
    pc.ondatachannel!({ channel: second });
    first.open();
    second.open();
    second.receive(JSON.stringify({ type: 'chat', text: 'from second' }));
    second.receive(hello);
    expect(second.closed).toBe(true);
    expect(first.closed).toBe(false);
    expect(second.sent).toEqual([]);
    expect(onChat).not.toHaveBeenCalled();
    expect(peer.sendChat('hi', false)).toBe(false);
    first.receive(hello);
    expect(peer.sendChat('hi', false)).toBe(true);
    expect(second.sent).toEqual([]);
  });

  it('returns false when the channel is not open, and when send throws', () => {
    const { peer, pc } = make();
    const channel = received(peer, pc);
    channel.receive(hello);
    expect(peer.sendChat('hi', false)).toBe(false);
    channel.open();
    channel.sent.length = 0;
    channel.throwOnSend = true;
    expect(peer.sendChat('hi', false)).toBe(false);
    expect(channel.sent).toEqual([]);
  });

  it('does not throw when the hello cannot be sent', () => {
    const { peer, pc } = make();
    const channel = received(peer, pc);
    channel.throwOnSend = true;
    expect(() => channel.open()).not.toThrow();
  });

  it('sends nothing after close and forgets the hello', () => {
    const { peer, pc } = make();
    const channel = received(peer, pc);
    channel.open();
    channel.receive(hello);
    expect(peer.sendChat('hi', false)).toBe(true);
    channel.sent.length = 0;
    peer.close();
    expect(peer.sendChat('hi', false)).toBe(false);
    expect(channel.sent).toEqual([]);
  });

  it('needs the hello again on a channel taken after close', () => {
    const { peer, pc } = make();
    const old = received(peer, pc);
    old.open();
    old.receive(hello);
    peer.close();
    const fresh = received(peer, pc);
    fresh.open();
    expect(peer.sendChat('hi', false)).toBe(false);
    fresh.receive(hello);
    old.sent.length = 0;
    expect(peer.sendChat('hi', false)).toBe(true);
    expect(old.sent).toEqual([]);
    expect(fresh.sent).toEqual([hello, JSON.stringify({ type: 'chat', text: 'hi' })]);
  });
});

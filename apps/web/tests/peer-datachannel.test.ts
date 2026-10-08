import { describe, it, expect, vi } from 'vitest';
import { PeerConnection } from '@/lib/peer';
import {
  DATA_CHANNEL_BACKUP,
  DATA_CHANNEL_RECORDING,
  DATA_CHANNEL_RECORDING_AUDIO,
} from '@openmeet/protocol';

class FakePC {
  ontrack: unknown = null;
  onicecandidate: unknown = null;
  onnegotiationneeded: unknown = null;
  ondatachannel: ((ev: { channel: { label: string } }) => void) | null = null;
  created: { label: string; opts: unknown }[] = [];
  addTrack() {}
  createDataChannel(label: string, opts?: unknown) {
    const ch = { label, opts };
    this.created.push({ label, opts });
    return ch as unknown as RTCDataChannel;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
  signalingState = 'stable';
  localDescription = { sdp: '' };
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
    pc.ondatachannel!({ channel: { label: 'control' } });
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

  it('createRecordingChannel(key) suffixes the label with #<key>', () => {
    const { peer } = make();
    peer.start();
    const ch = peer.createRecordingChannel('rec-123');
    expect((ch as unknown as { label: string }).label).toBe(`${DATA_CHANNEL_RECORDING}#rec-123`);
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
    pc.ondatachannel!({ channel: { label: 'control' } });
    expect(onDataChannel).toHaveBeenCalledTimes(1);
    expect(onDataChannel).toHaveBeenCalledWith({ label: `${DATA_CHANNEL_BACKUP}#x.mp4` });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom } from '@/hooks/useRoom';
import {
  startGuestRecording,
  startHostRecording,
  resumeHostRecording,
} from '@/hooks/recording-controller';
import { BackupRecorder } from '@/lib/backup-recorder';
import { SwitchableMedia } from '@/lib/switchable-media';
import { findTakeJournals, type TakeJournal } from '@/lib/take-journal';
import { installStableGraph, type FakeGraphContext } from './stable-graph-fakes';

/**
 * Which audio track each recorder holds. The camera file, its backup and the
 * call share the stable track; the uncompressed master has one of its own.
 */

let signalHandlers: Record<string, ((m: any) => void)[]> = {};
let peers: any[] = [];
let graphs: FakeGraphContext[] = [];

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ urls: [], username: 'stub', credential: 'stub', ttl: 0 }),
  getRoom: vi.fn().mockResolvedValue({ slug: 'test-room', expires_at: Date.now() + 10000 }),
  patchRecording: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn((type: string, handler: (m: any) => void) => {
      (signalHandlers[type] ??= []).push(handler);
    }),
  })),
}));

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation(() => {
    const channel = () => ({ readyState: 'open', addEventListener: vi.fn(), send: vi.fn(), close: vi.fn() });
    const p = {
      start: vi.fn(),
      close: vi.fn(),
      setLocalStream: vi.fn(),
      setLocalStreamAfterFirstOffer: vi.fn(),
      createControlChannel: vi.fn(),
      replaceAudioTrack: vi.fn(),
      addTransceiver: vi.fn(),
      restartIce: vi.fn(),
      connectionState: 'connected',
      rawConnection: null,
      setPeerCount: vi.fn(),
      whenConnected: vi.fn().mockResolvedValue(undefined),
      createRecordingChannel: vi.fn().mockImplementation(channel),
      createRecordingAudioChannel: vi.fn().mockImplementation(channel),
    };
    peers.push(p);
    return p;
  }),
}));

vi.mock('@/lib/recorder', async () => {
  const actual = await vi.importActual<typeof import('@/lib/recorder')>('@/lib/recorder');
  return { ...actual, pickRecordingMime: vi.fn().mockReturnValue('video/mp4') };
});

vi.mock('@/lib/backup-recorder', async () => {
  const actual = await vi.importActual<typeof import('@/lib/backup-recorder')>('@/lib/backup-recorder');
  return {
    ...actual,
    BackupRecorder: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn().mockResolvedValue(null) })),
  };
});

vi.mock('@/lib/take-journal', async () => {
  const actual = await vi.importActual<typeof import('@/lib/take-journal')>('@/lib/take-journal');
  return { ...actual, findTakeJournals: vi.fn().mockResolvedValue([]) };
});

vi.mock('@/hooks/recording-controller', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/recording-controller')>(
    '@/hooks/recording-controller'
  );
  return {
    ...actual,
    startHostRecording: vi.fn().mockResolvedValue({ recordingId: 'rec-host', hostStartMs: 0 }),
    startGuestRecording: vi.fn().mockReturnValue({ recordingId: 'rec-guest' }),
    resumeHostRecording: vi.fn(),
  };
});

function emit(type: string, payload: any) {
  for (const h of signalHandlers[type] ?? []) h({ type, ...payload });
}

const track = (kind: 'audio' | 'video', id: string, enabled = true) =>
  ({
    kind,
    id,
    enabled,
    stop: vi.fn(),
    getSettings: () => ({ deviceId: id, channelCount: 2 }),
  }) as unknown as MediaStreamTrack;

const lobby = () => new MediaStream([track('audio', 'raw-mic'), track('video', 'raw-cam')]);

/** The nodes a source was connected to, compared by identity. */
const connectedTo = (source: { connect: ReturnType<typeof vi.fn> }) =>
  source.connect.mock.calls.map(([to]) => to);

async function joinAs(role: 'host' | 'guest', others: { peerId: string; ordinal: number; role: string }[]) {
  const hook = renderHook(() => useRoom('abc-defg-hij'));
  await act(async () => {
    await hook.result.current.join(lobby(), 'Me');
  });
  act(() => {
    emit('role-assigned', {
      role,
      peerId: 'me',
      ordinal: role === 'host' ? 1 : 9,
      peers: others.map((o) => ({ ...o, displayName: o.peerId })),
      recording: false,
    });
  });
  return hook;
}

beforeEach(() => {
  signalHandlers = {};
  peers = [];
  graphs = installStableGraph();
  vi.mocked(findTakeJournals).mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SwitchableMedia: the microphone-only stream', () => {
  it('is a track of its own, fed by the microphone beside the stable one', () => {
    const sm = new SwitchableMedia(lobby(), { stereo: true });
    const [stable, micOnly] = graphs[0]!.dests;

    expect(sm.stream.getAudioTracks()).toEqual(stable!.stream.getAudioTracks());
    expect(sm.micStream).toBe(micOnly!.stream);
    expect(sm.micStream.getAudioTracks()[0]).not.toBe(sm.stream.getAudioTracks()[0]);
    // One source, the microphone, feeding both.
    expect(graphs[0]!.sources).toHaveLength(1);
    expect(connectedTo(graphs[0]!.sources[0]!)).toContain(stable);
    expect(connectedTo(graphs[0]!.sources[0]!)).toContain(micOnly);
    // The master has the channel count the camera file has.
    expect(stable!.channelCount).toBe(2);
    expect(micOnly!.channelCount).toBe(2);
    expect(micOnly!.channelCountMode).toBe('explicit');
  });

  it('keeps feeding it after a change of microphone', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'test-desktop',
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(new MediaStream([track('audio', 'mic-2')])) },
    });
    const sm = new SwitchableMedia(lobby());
    const [stable, micOnly] = graphs[0]!.dests;

    await sm.switchMic('mic-2');

    const next = graphs[0]!.sources[1]!;
    expect(connectedTo(next)).toContain(stable);
    expect(connectedTo(next)).toContain(micOnly);
    expect(sm.micStream).toBe(micOnly!.stream);
  });

  it('is switched off with the microphone: in the app, and from the start', () => {
    const sm = new SwitchableMedia(lobby());
    const micOnly = sm.micStream.getAudioTracks()[0]!;
    expect(micOnly.enabled).toBe(true);

    sm.setAudioEnabled(false);
    expect(micOnly.enabled).toBe(false);
    sm.setAudioEnabled(true);
    expect(micOnly.enabled).toBe(true);

    const joinedMuted = new SwitchableMedia(
      new MediaStream([track('audio', 'raw-mic', false), track('video', 'raw-cam')])
    );
    expect(joinedMuted.micStream.getAudioTracks()[0]!.enabled).toBe(false);
  });

  it('is the stream itself where there is no audio graph', () => {
    // No MediaStreamTrackGenerator: the raw-track fallback.
    vi.unstubAllGlobals();
    const sm = new SwitchableMedia(lobby());
    expect(sm.isFallback).toBe(true);
    expect(sm.micStream).toBe(sm.stream);
  });
});

describe('the uncompressed master in a call', () => {
  it("records the host's master from the microphone-only track and the camera file from the stable one", async () => {
    const { result } = await joinAs('host', []);
    act(() => {
      emit('peer-joined', { peerId: 'g1', ordinal: 2, role: 'guest', displayName: 'A' });
    });

    await act(async () => {
      await result.current.startRecording();
    });

    const [stable, micOnly] = graphs[0]!.dests;
    const args = vi.mocked(startHostRecording).mock.calls[0]![0];
    expect(args.localStream.getAudioTracks()).toEqual(stable!.stream.getAudioTracks());
    expect(args.micStream).toBe(micOnly!.stream);
  });

  it("records a guest's master and its backup from the microphone-only track", async () => {
    await joinAs('guest', [{ peerId: 'h', ordinal: 1, role: 'host' }]);

    await act(async () => {
      emit('recording-started', { from: 'host', recordingId: 'r1', kind: 'camera', filename: 'x.mp4' });
    });
    await vi.waitFor(() => expect(vi.mocked(startGuestRecording)).toHaveBeenCalled());

    const [stable, micOnly] = graphs[0]!.dests;
    const args = vi.mocked(startGuestRecording).mock.calls[0]![0];
    expect(args.localStream.getAudioTracks()).toEqual(stable!.stream.getAudioTracks());
    expect(args.micStream).toBe(micOnly!.stream);
    const backups = vi.mocked(BackupRecorder).mock.calls.map(([o]) => o as any);
    expect(backups.find((o) => o.mimeType === 'audio/wav').stream).toBe(micOnly!.stream);
    expect(backups.find((o) => o.mimeType !== 'audio/wav').stream.getAudioTracks()).toEqual(
      stable!.stream.getAudioTracks()
    );
  });

  it("records the host's resumed master from the microphone-only track", async () => {
    // This browser's crash copy of the room's take, as findTakeJournals hands it back.
    const crashCopy = {
      dirName: 'openmeet-take-1',
      notes: {
        room: 'abc-defg-hij',
        recordingId: 'rec-1',
        take: 1,
        hostStartMs: 1_000,
        files: [],
        backups: [],
        markers: [],
      },
      notesOk: true,
      dead: false,
      bytes: 0,
    } as unknown as TakeJournal;
    vi.mocked(findTakeJournals).mockResolvedValue([crashCopy]);
    vi.mocked(resumeHostRecording).mockResolvedValue({ recordingId: 'rec-1', take: 1, hostStartMs: 1_000 });
    const { result } = await joinAs('host', [{ peerId: 'g1', ordinal: 2, role: 'guest' }]);
    await vi.waitFor(() => expect(result.current.state.resumeOffer).not.toBeNull());

    await act(async () => {
      await result.current.resumeRecording();
    });

    const [stable, micOnly] = graphs[0]!.dests;
    const args = vi.mocked(resumeHostRecording).mock.calls[0]![0];
    expect(args.localStream.getAudioTracks()).toEqual(stable!.stream.getAudioTracks());
    expect(args.micStream).toBe(micOnly!.stream);
  });
});

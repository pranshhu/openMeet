import { describe, it, expect, vi } from 'vitest';
import {
  forgetPreTakeGuestChannels,
  handleGuestRecordingStarted,
  recordingErrorOnPeerJoined,
} from '@/hooks/useRoom';
import type { PendingRecordingChannel, RecordingHandles } from '@/hooks/recording-controller';

describe('host takeover and take start channel handling', () => {
  it('channels arriving before a take starts are forgotten and not closed at take start', () => {
    const videoClose = vi.fn();
    const audioClose = vi.fn();

    const staleVideoChannel = {
      label: 'recording#old-rec-id',
      close: videoClose,
    } as unknown as RTCDataChannel;

    const staleAudioChannel = {
      label: 'recording-audio#old-rec-id',
      close: audioClose,
    } as unknown as RTCDataChannel;

    const pending = {
      current: [
        { channel: staleVideoChannel, peerId: 'peer-1' },
        { channel: staleAudioChannel, peerId: 'peer-1' },
      ] as PendingRecordingChannel[],
    };

    forgetPreTakeGuestChannels(pending);

    // Channels from before the take must NOT be closed (closing them stalls guest drain)
    expect(videoClose).not.toHaveBeenCalled();
    expect(audioClose).not.toHaveBeenCalled();

    // The list is cleared so take start cannot bind them to fresh receivers
    expect(pending.current).toEqual([]);
  });
});

describe('guest response to host recording-started during active recording', () => {
  it('a guest already recording ends its take and starts a new one with a new recordingId', async () => {
    let currentRecId = 'old-rec-id';
    const recordingRef = {
      current: { recordingId: currentRecId } as RecordingHandles | null,
    };

    let takeEnded = false;
    let newTakeStarted = false;
    const callOrder: string[] = [];

    const endRecording = vi.fn().mockImplementation(async () => {
      callOrder.push('end');
      takeEnded = true;
      // Clearing recordingRef matches what endRecording guest branch does
      recordingRef.current = null;
    });

    const beginGuestRecording = vi.fn().mockImplementation(async () => {
      callOrder.push('begin');
      currentRecId = 'new-rec-id';
      newTakeStarted = true;
      recordingRef.current = { recordingId: currentRecId } as RecordingHandles;
    });

    await handleGuestRecordingStarted({
      recordingRef,
      endRecording,
      beginGuestRecording,
    });

    expect(callOrder).toEqual(['end', 'begin']);
    expect(takeEnded).toBe(true);
    expect(newTakeStarted).toBe(true);
    expect(recordingRef.current?.recordingId).toBe('new-rec-id');
  });

  it('a guest not already recording begins the new take without ending anything', async () => {
    const recordingRef = {
      current: null as RecordingHandles | null,
    };

    const endRecording = vi.fn().mockResolvedValue(undefined);
    const beginGuestRecording = vi.fn().mockImplementation(async () => {
      recordingRef.current = { recordingId: 'brand-new-id' } as RecordingHandles;
    });

    await handleGuestRecordingStarted({
      recordingRef,
      endRecording,
      beginGuestRecording,
    });

    expect(endRecording).not.toHaveBeenCalled();
    expect(beginGuestRecording).toHaveBeenCalledTimes(1);
    expect(recordingRef.current?.recordingId).toBe('brand-new-id');
  });
});

describe('recordingError clearing on peer join', () => {
  it('clears stale recordingError when a host joins', () => {
    const staleError = 'The other person disconnected. Press End & save to keep this recording.';
    const cleared = recordingErrorOnPeerJoined('recording', 'host', staleError);
    expect(cleared).toBeNull();
  });

  it('clears recordingError when phase is peer-left regardless of role', () => {
    const staleError = 'The other person disconnected. Press End & save to keep this recording.';
    const cleared = recordingErrorOnPeerJoined('peer-left', 'guest', staleError);
    expect(cleared).toBeNull();
  });

  it('preserves recordingError during recording if a non-host joins', () => {
    const currentError = 'Some recording error';
    const result = recordingErrorOnPeerJoined('recording', 'guest', currentError);
    expect(result).toBe(currentError);
  });
});

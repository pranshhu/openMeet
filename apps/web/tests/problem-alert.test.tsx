import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, fireEvent, act } from '@testing-library/react';
import { useProblemAlert, requestProblemNotifications } from '@/hooks/use-problem-alert';
import { CallStage } from '@/components/CallStage';

class FakeGainNode {
  gain = {
    value: 1,
    setValueAtTime: vi.fn(),
  };
  connect = vi.fn();
}

class FakeOscillatorNode {
  type = 'sine';
  frequency = { value: 440 };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = {};
  createOscillator = vi.fn(() => new FakeOscillatorNode());
  createGain = vi.fn(() => new FakeGainNode());
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
}

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn().mockResolvedValue('granted');
  static instances: FakeNotification[] = [];

  title: string;
  options?: NotificationOptions | undefined;
  onclick: ((this: Notification, ev: Event) => any) | null = null;
  close = vi.fn();

  constructor(title: string, options?: NotificationOptions | undefined) {
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }
}

describe('useProblemAlert and requestProblemNotifications', () => {
  let originalAudioContext: unknown;
  let originalNotification: unknown;
  let originalHidden: PropertyDescriptor | undefined;

  beforeEach(() => {
    FakeNotification.instances = [];
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission = vi.fn().mockResolvedValue('granted');

    originalAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext ?? window.AudioContext;
    originalNotification = (window as unknown as { Notification?: unknown }).Notification;
    originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

    (window as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
    (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
    (window as unknown as { Notification: typeof FakeNotification }).Notification = FakeNotification;
    (globalThis as unknown as { Notification: typeof FakeNotification }).Notification = FakeNotification;

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
  });

  afterEach(() => {
    if (originalAudioContext !== undefined) {
      window.AudioContext = originalAudioContext as typeof AudioContext;
      (globalThis as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
    } else {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
      delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    }

    if (originalNotification !== undefined) {
      (window as unknown as { Notification: unknown }).Notification = originalNotification;
      (globalThis as unknown as { Notification: unknown }).Notification = originalNotification;
    } else {
      delete (window as unknown as { Notification?: unknown }).Notification;
      delete (globalThis as unknown as { Notification?: unknown }).Notification;
    }

    if (originalHidden) {
      Object.defineProperty(document, 'hidden', originalHidden);
    } else {
      delete (document as unknown as { hidden?: unknown }).hidden;
    }
  });

  describe('alert firing conditions', () => {
    it('fires once for a new message while active; not while inactive; not again on a re-render with the same message; again for a different message; once when active turns true with a message already present', async () => {
      FakeNotification.permission = 'granted';

      // 1. Not while inactive
      const { rerender } = renderHook(
        ({ active, message }: { active: boolean; message: string | null }) =>
          useProblemAlert({ active, message }),
        { initialProps: { active: false, message: 'Disk is full' as string | null } }
      );
      expect(FakeNotification.instances).toHaveLength(0);

      // 2. Once when active turns true with a message already present
      rerender({ active: true, message: 'Disk is full' });
      expect(FakeNotification.instances).toHaveLength(1);
      expect(FakeNotification.instances[0]?.options?.body).toBe('Disk is full');

      // 3. Not again on a re-render with the same message
      rerender({ active: true, message: 'Disk is full' });
      expect(FakeNotification.instances).toHaveLength(1);

      // 4. Again for a different message
      rerender({ active: true, message: 'Connection lost' });
      expect(FakeNotification.instances).toHaveLength(2);
      expect(FakeNotification.instances[1]?.options?.body).toBe('Connection lost');

      // 5. Fires once for a new message while active (transitioning from null to message)
      rerender({ active: true, message: null });
      expect(FakeNotification.instances).toHaveLength(2);
      rerender({ active: true, message: 'Stalled track' });
      expect(FakeNotification.instances).toHaveLength(3);
      expect(FakeNotification.instances[2]?.options?.body).toBe('Stalled track');
    });
  });

  describe('sound and notification behavior', () => {
    it('creates a notification only when the page is hidden and permission is granted', () => {
      FakeNotification.permission = 'default';
      const { rerender } = renderHook(
        ({ active, message }: { active: boolean; message: string | null }) =>
          useProblemAlert({ active, message }),
        { initialProps: { active: true, message: 'First error' } }
      );
      // Not granted -> no notification
      expect(FakeNotification.instances).toHaveLength(0);

      // Hidden = false (tab visible) -> no notification even when granted
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      });
      FakeNotification.permission = 'granted';
      rerender({ active: true, message: 'Second error' });
      expect(FakeNotification.instances).toHaveLength(0);

      // Hidden = true and granted -> notification created
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => true,
      });
      rerender({ active: true, message: 'Third error' });
      expect(FakeNotification.instances).toHaveLength(1);
      const notif = FakeNotification.instances[0]!;
      expect(notif.title).toBe('openMeet: recording needs attention');
      expect(notif.options).toEqual({
        body: 'Third error',
        tag: 'openmeet-recording',
      });

      // Clicking focuses the window and closes the notification
      const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});
      notif.onclick?.call(notif as unknown as Notification, new Event('click'));
      expect(focusSpy).toHaveBeenCalled();
      expect(notif.close).toHaveBeenCalled();
      focusSpy.mockRestore();
    });

    it('does not throw when Notification or AudioContext is missing', () => {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
      delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
      delete (window as unknown as { Notification?: unknown }).Notification;
      delete (globalThis as unknown as { Notification?: unknown }).Notification;

      expect(() => {
        renderHook(() => useProblemAlert({ active: true, message: 'Problem occurred' }));
      }).not.toThrow();
    });

    it('plays sound through AudioContext, reuses context and closes it on unmount', async () => {
      let createdContext: FakeAudioContext | null = null;
      class TrackingAudioContext extends FakeAudioContext {
        constructor() {
          super();
          createdContext = this;
        }
      }
      (window as unknown as { AudioContext: typeof TrackingAudioContext }).AudioContext = TrackingAudioContext;
      (globalThis as unknown as { AudioContext: typeof TrackingAudioContext }).AudioContext = TrackingAudioContext;

      const { rerender, unmount } = renderHook(
        ({ active, message }: { active: boolean; message: string | null }) =>
          useProblemAlert({ active, message }),
        { initialProps: { active: true, message: 'Error 1' } }
      );

      await Promise.resolve();
      expect(createdContext).not.toBeNull();
      const ctx = createdContext!;
      expect(ctx.createOscillator).toHaveBeenCalled();
      expect(ctx.createGain).toHaveBeenCalled();

      // Second alert reuses the same context
      rerender({ active: true, message: 'Error 2' });
      await Promise.resolve();
      expect(createdContext).toBe(ctx);

      // Unmount closes context
      unmount();
      expect(ctx.close).toHaveBeenCalled();
    });

    it('skips sound silently when resume() rejects', async () => {
      class RejectingAudioContext extends FakeAudioContext {
        override resume = vi.fn().mockRejectedValue(new Error('Autoplay blocked'));
      }
      (window as unknown as { AudioContext: typeof RejectingAudioContext }).AudioContext = RejectingAudioContext;
      (globalThis as unknown as { AudioContext: typeof RejectingAudioContext }).AudioContext = RejectingAudioContext;

      expect(() => {
        renderHook(() => useProblemAlert({ active: true, message: 'Error' }));
      }).not.toThrow();
    });
  });

  describe('requestProblemNotifications', () => {
    it('asks only when the permission is default', () => {
      FakeNotification.permission = 'granted';
      requestProblemNotifications();
      expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

      FakeNotification.permission = 'denied';
      requestProblemNotifications();
      expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

      FakeNotification.permission = 'default';
      requestProblemNotifications();
      expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    });

    it('ignores rejections and throws without breaking', () => {
      FakeNotification.permission = 'default';
      FakeNotification.requestPermission = vi.fn().mockRejectedValue(new Error('User dismissed'));
      expect(() => requestProblemNotifications()).not.toThrow();

      FakeNotification.requestPermission = vi.fn().mockImplementation(() => {
        throw new Error('Sync throw');
      });
      expect(() => requestProblemNotifications()).not.toThrow();
    });
  });

  describe('CallStage integration', () => {
    const baseCallStageProps = {
      role: 'host' as const,
      phase: 'in-call' as const,
      localStream: null,
      remoteStream: null,
      remotePeers: [],
      remoteScreenStream: null,
      localScreenStream: null,
      localName: 'Alice',
      peerName: 'Bob',
      screenSharing: false,
      canRecord: true,
      roomRecording: false,
      recordBlocked: false,
      messages: [],
      peerPresence: null,
      screenShareSupported: true,
      backupUrl: null,
      wavBackupUrl: null,
      syncReportUrl: null,
      recordingError: null,
      recordUnavailableReason: null,
      onToggleMic: vi.fn(),
      onToggleCam: vi.fn(),
      onRecord: vi.fn(),
      onEnd: vi.fn(),
      onLeave: vi.fn(),
      onSendChat: vi.fn(),
      slug: 'abc-defg-hij',
      onMark: vi.fn(),
      markerCount: 0,
      chaptersUrl: null,
      summary: null,
      takes: [],
      onNewTake: vi.fn(),
      onDiscardTake: vi.fn(),
      onOpenMediaBoard: vi.fn(() => null),
      onToggleScreen: vi.fn(),
      capabilities: {},
    };

    it('calls requestProblemNotifications on Record click, and recording still starts when requestPermission rejects or throws', () => {
      FakeNotification.permission = 'default';
      FakeNotification.requestPermission = vi.fn().mockRejectedValue(new Error('Denied'));

      const onRecord = vi.fn();
      render(<CallStage {...baseCallStageProps} onRecord={onRecord} />);

      const recordBtn = screen.getByRole('button', { name: 'Start recording' });
      fireEvent.click(recordBtn);

      expect(FakeNotification.requestPermission).toHaveBeenCalled();
      expect(onRecord).toHaveBeenCalledTimes(1);
    });

    it('alerts on recording problems during active recording in CallStage', () => {
      FakeNotification.permission = 'granted';
      render(
        <CallStage
          {...baseCallStageProps}
          phase="recording"
          recordingError="Disk is full"
        />
      );
      expect(FakeNotification.instances).toHaveLength(1);
      expect(FakeNotification.instances[0]?.options?.body).toBe('Disk is full');
    });

    it('does not sound or raise system notification for silent mic', () => {
      FakeNotification.permission = 'granted';
      render(
        <CallStage
          {...baseCallStageProps}
          phase="recording"
          micWarning="silent"
          recordingError={null}
        />
      );
      expect(FakeNotification.instances).toHaveLength(0);
    });

    it('still starts recording when requestPermission throws synchronously', () => {
      FakeNotification.permission = 'default';
      FakeNotification.requestPermission = vi.fn().mockImplementation(() => {
        throw new Error('Explosion');
      });

      const onRecord = vi.fn();
      render(<CallStage {...baseCallStageProps} onRecord={onRecord} />);

      const recordBtn = screen.getByRole('button', { name: 'Start recording' });
      expect(() => fireEvent.click(recordBtn)).not.toThrow();
      expect(onRecord).toHaveBeenCalledTimes(1);
    });
  });
});

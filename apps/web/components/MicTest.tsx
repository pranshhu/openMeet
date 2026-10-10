'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { MIC_TEST_MS, recordMicSample } from '@/lib/mic-test';

type Step = 'idle' | 'recording' | 'playing' | 'done' | 'off' | 'failed';

const NOTE: Record<Step, string> = {
  idle: '',
  recording: `Recording ${MIC_TEST_MS / 1000} seconds. Say a few words.`,
  playing: 'Playing it back. This is how your mic sounds.',
  done: 'Test deleted. It never left this browser.',
  off: 'Your microphone is off. Turn it on, then test again.',
  failed: 'This browser could not record a test.',
};

/**
 * Lets a person hear their own microphone before a call: a few seconds are
 * recorded in this tab, played back once and dropped. Memoized because the
 * panel around it renders on every animation frame for its level meter.
 */
export const MicTest = memo(function MicTest({ stream }: { stream: MediaStream | null }) {
  const [step, setStep] = useState<Step>('idle');
  const [clip, setClip] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);

  // The clip is dropped as soon as it is replaced, played to the end or left behind.
  useEffect(() => {
    if (!clip) return;
    return () => URL.revokeObjectURL(clip);
  }, [clip]);

  // Leaving the lobby ends a test in progress: its recorder must not run into the call.
  useEffect(() => () => run.current?.abort(), []);

  async function start(mic: MediaStreamTrack) {
    setClip(null);
    // Read at the click: the lobby's mic button switches the track itself off.
    if (!mic.enabled) {
      setStep('off');
      return;
    }
    const controller = new AbortController();
    run.current = controller;
    setStep('recording');
    try {
      const blob = await recordMicSample(mic, MIC_TEST_MS, controller.signal);
      if (controller.signal.aborted) return;
      if (blob.size === 0) {
        setStep('failed');
        return;
      }
      setClip(URL.createObjectURL(blob));
      setStep('playing');
    } catch {
      if (!controller.signal.aborted) setStep('failed');
    }
  }

  const track = stream?.getAudioTracks()[0];
  if (!track) return null;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => void start(track)}
        disabled={step === 'recording'}
        className="-ml-3 inline-flex min-h-11 items-center rounded-full px-3 text-sm font-medium text-[#0b57d0] transition-colors enabled:hover:bg-[#0b57d0]/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b57d0]"
      >
        Test your mic
      </button>
      {clip && (
        <audio
          src={clip}
          autoPlay
          controls
          aria-label="Your microphone test"
          onEnded={() => {
            setClip(null);
            setStep('done');
          }}
          className="mt-1 block h-11 w-full"
        />
      )}
      {/* Inserted on the first press, not rendered empty: a screen reader announces it. */}
      {NOTE[step] && (
        <p role="status" className="text-[#5f6368]">
          {NOTE[step]}
        </p>
      )}
    </div>
  );
});

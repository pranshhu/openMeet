'use client';

import { useSyncExternalStore } from 'react';
import { onSpeakerChange, speakerId } from '@/lib/speaker';

/** The chosen speaker's device id as state; '' is the system default. */
export function useSpeakerId(): string {
  return useSyncExternalStore(onSpeakerChange, speakerId, () => '');
}

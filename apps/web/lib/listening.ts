import type { Listening } from '@openmeet/protocol';

/** The lobby's wording for each answer; '' is the question, shown until one is given. */
export const LISTENING_LABEL: Record<Listening | '', string> = {
  '': 'Headphones or speakers?',
  headphones: 'Listening on: headphones',
  speakers: 'Listening on: speakers',
  'speakers-ec': 'Speakers, echo cancellation on',
};

/** What an answer means for the person's own recording; nothing where it changes nothing. */
export const LISTENING_HINT: Record<Listening | '', string> = {
  '': '',
  headphones: '',
  speakers: 'Your microphone will pick up the others from your speakers.',
  'speakers-ec': 'Your microphone is processed to take the others out, so your recording is not raw audio.',
};

// The answer this tab joined with, '' when none was given. Held here like the
// bitrate level in lib/quality.ts, so the call tells the host what the lobby
// showed, whatever storage holds by then.
let joinedListening: Listening | '' = '';

export function chooseListening(answer: Listening | ''): void {
  joinedListening = answer;
}

/** The answer as a `recording-capability` field: nothing when the person did not say. */
export function listeningField(): { listening?: Listening } {
  return joinedListening ? { listening: joinedListening } : {};
}

/** The host's wording for each answer, on that person's name tag. */
export const LISTENING_TAG: Record<Listening, string> = {
  headphones: 'headphones',
  speakers: 'on speakers',
  'speakers-ec': 'on speakers, echo cancelled',
};

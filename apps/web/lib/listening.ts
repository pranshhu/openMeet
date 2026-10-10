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

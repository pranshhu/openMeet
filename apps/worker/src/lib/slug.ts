import { isRoomSlug } from '@openmeet/protocol';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

function randomLetters(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function generateSlug(): string {
  return `${randomLetters(3)}-${randomLetters(4)}-${randomLetters(3)}`;
}

export const isValidSlugFormat = isRoomSlug;

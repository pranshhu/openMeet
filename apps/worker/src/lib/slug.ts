const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const SLUG_REGEX = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

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

export function isValidSlugFormat(s: string): boolean {
  return SLUG_REGEX.test(s);
}

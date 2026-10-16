import { MAX_CHAT_MESSAGE_LENGTH } from './sync-report';

/** First frame each side sends on a `control` channel: it says this page reads chat from it. */
export const PEER_CHAT_HELLO = '{"type":"hello"}';

/** The longest frame read: a line of MAX_CHAT_MESSAGE_LENGTH units, every unit escaped. */
export const MAX_PEER_CHAT_FRAME = 32_768;

export type PeerChatFrame = { type: 'hello' } | { type: 'chat'; text: string; private: boolean };

/** A line for everyone, or, with isPrivate, for the one person at the other end. */
export function encodePeerChat(text: string, isPrivate: boolean): string {
  return JSON.stringify(isPrivate ? { type: 'chat', text, private: true } : { type: 'chat', text });
}

/**
 * Reads one frame from another participant. Size and shape are checked here, before
 * anything else sees the data; whatever does not fit is null and nothing throws.
 * Only the known fields are copied out.
 */
export function readPeerChat(data: unknown): PeerChatFrame | null {
  if (typeof data !== 'string' || data.length > MAX_PEER_CHAT_FRAME) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  // A primitive or an array has no `type`, so only null needs a check of its own.
  const frame = value as Record<string, unknown> | null;
  if (frame?.type === 'hello') return { type: 'hello' };
  if (frame?.type !== 'chat') return null;
  const { text } = frame;
  if (typeof text !== 'string' || text.length > MAX_CHAT_MESSAGE_LENGTH) return null;
  if (frame.private !== undefined && typeof frame.private !== 'boolean') return null;
  return { type: 'chat', text, private: frame.private === true };
}

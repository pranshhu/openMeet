'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { SendFile } from './SendFile';
import { MAX_CHAT_MESSAGE_LENGTH, type ChatMessage } from '@/lib/sync-report';

export type { ChatMessage };

export function chatSenderLabel(
  m: Pick<ChatMessage, 'from' | 'fromName' | 'self'>
): string {
  return m.self ? 'You' : (m.fromName || (m.from.charAt(0).toUpperCase() + m.from.slice(1)));
}

/** Who else is on a private line, in this page's own words. */
export function privateDetail(
  m: Pick<ChatMessage, 'from' | 'self' | 'fromPeerId' | 'toPeerId' | 'toRole'>,
  numbers: Map<string, number>
): string {
  if (m.self) return m.toPeerId ? `to ${personTag(m.toPeerId, m.toRole ?? 'guest', numbers)}` : 'to one person';
  if (m.fromPeerId) return `from ${personTag(m.fromPeerId, m.from, numbers)}`;
  return m.from === 'host' ? 'from Host' : m.from === 'producer' ? 'from a producer' : 'from a guest';
}

/**
 * The mark of a message the Room delivered to one person. It is an element of
 * its own, drawn from the flag this page set when the message arrived or was
 * sent, never from the label's text: a display name is its owner's to choose,
 * and no name can draw this.
 */
export function PrivateMark({ detail }: { detail: string }) {
  return (
    <span
      data-private-mark=""
      className="mr-1.5 inline-block rounded bg-[#8ab4f8] px-1.5 text-[11px] font-semibold leading-4 text-[#062e6f]"
    >
      {`Private · ${detail}`}
    </span>
  );
}

/**
 * What a line for everyone starts with for someone who hears the page. The
 * private mark is told from a name by its box, which is not read out, so a
 * name could say the mark's words; with this the first words of every line
 * are this page's own. It is not drawn.
 */
export function PublicMark() {
  return <span className="sr-only">To everyone: </span>;
}

// A display name is its owner's text, up to 64 characters; an option has to fit a phone.
const optionName = (name: string) => {
  const chars = Array.from(name);
  return chars.length > 16 ? `${chars.slice(0, 16).join('')}…` : name;
};

/**
 * What this page calls a person, in its own words: the role the Room gave
 * them and, for anyone but the host, a number this page gave them when it
 * first met them. Nothing in it is the person's own text, so no name can
 * draw it, imitate it or share it. `numbers` is the caller's memory for as
 * long as the page is in the room: a number stays with its id and is never
 * given to anyone else, also after that person has left.
 */
export function personTag(peerId: string, role: string, numbers: Map<string, number>): string {
  if (role === 'host') return 'Host';
  let n = numbers.get(peerId);
  if (!n) {
    n = numbers.size + 1;
    numbers.set(peerId, n);
  }
  return `${role === 'producer' ? 'Producer' : 'Guest'} ${n}`;
}

/**
 * Numbers the people listed, in the order they are listed, so the numbers
 * follow who joined first and not who first wrote. A present-only device is
 * someone's second screen, not a person to write to, and takes none.
 */
export function numberPeers(
  peers: { peerId: string; role?: string | undefined; companion?: boolean | undefined }[],
  numbers: Map<string, number>
): void {
  for (const p of peers) if (!p.companion) personTag(p.peerId, p.role ?? 'guest', numbers);
}

// A person under To: this page's words for them first, then the name they
// chose, cut to fit a phone. An option holds text only, so the name comes
// last, where nothing this page writes can be changed by it.
export function recipientLabels<T extends { peerId: string; name: string; role: string }>(
  recipients: T[],
  numbers: Map<string, number>
): (T & { tag: string; label: string })[] {
  return recipients.map((r) => {
    const tag = personTag(r.peerId, r.role, numbers);
    return { ...r, tag, label: `${tag}: ${optionName(r.name)}` };
  });
}

export function ChatPanel({
  messages,
  recipients = [],
  to = '',
  onTo,
  numbers,
  onSend,
  onClose,
  onSendFile,
}: {
  messages: ChatMessage[];
  /** The people a message can be sent to on its own. */
  recipients?: { peerId: string; name: string; role: string }[];
  /**
   * Who the next message is for: '' is everyone, otherwise a peerId. The
   * caller keeps it, because this panel is gone whenever chat is closed.
   */
  to?: string;
  onTo?: (to: string) => void;
  /**
   * The numbers this page has given people, kept by the caller for the
   * reason it keeps `to`: this panel is gone whenever chat is closed.
   */
  numbers?: Map<string, number>;
  onSend: (text: string, to?: string) => void;
  onClose: () => void;
  /** Offer the host one file from this device. Left out on the host's own page. */
  onSendFile?: ((file: File) => void) | undefined;
}) {
  const [text, setText] = useState('');
  const [own] = useState(() => new Map<string, number>());
  const known = numbers ?? own;
  // The person the next message is for, while they are in the call. Once they
  // have left, or come back under a new id, nothing is sent until the sender
  // chooses again: falling back to everyone would publish a message written
  // for one person.
  const labelled = recipientLabels(recipients, known);
  const person = labelled.find((r) => r.peerId === to);
  const gone = to !== '' && !person;
  const listRef = useRef<HTMLDivElement>(null);
  // Follow new messages only while the reader is at the bottom; scrolling up to
  // read history pins the list until they come back down. Your own send always
  // jumps to the bottom.
  const atBottomRef = useRef(true);
  useEffect(() => {
    const l = listRef.current;
    if (l && (atBottomRef.current || messages[messages.length - 1]?.self)) l.scrollTop = l.scrollHeight;
  }, [messages.length]);

  // Opening chat means "I want to type": focus the composer. Mouse/trackpad
  // only, so a phone or tablet doesn't throw its keyboard over the call.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)')?.matches) inputRef.current?.focus();
  }, []);

  return (
    <aside
      aria-labelledby="chat-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      className="flex h-full w-full flex-col bg-[#202124] text-white sm:overflow-hidden sm:rounded-2xl sm:bg-[#2a2b2e]"
    >
      <header className="flex items-center justify-between px-4 py-3">
        <h2 id="chat-title" className="text-base font-medium">
          In-call messages
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          title="Close chat"
          className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:h-9 sm:w-9"
        >
          <Icon name="close" size={20} />
        </button>
      </header>

      <div
        ref={listRef}
        data-testid="chat-list"
        onScroll={(e) => {
          const l = e.currentTarget;
          atBottomRef.current = l.scrollHeight - l.scrollTop - l.clientHeight < 80;
        }}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-2 [scrollbar-color:rgb(255_255_255/0.25)_transparent] [scrollbar-width:thin]"
      >
        {messages.length === 0 && to === '' && (
          <>
            <p className="mt-4 text-center text-sm text-white/70">
              Messages are visible to everyone in the call.
            </p>
            <p className="mt-4 text-center text-sm text-white/70">
              They go straight to each person, not through the server.
            </p>
          </>
        )}
        {messages.map((m, i) => {
          const sender = chatSenderLabel(m);
          return (
            // Each bubble hugs its text, and your own sit on the right, so a
            // message never reads as a second text field.
            <div key={i} className={`text-sm ${m.self ? 'flex flex-col items-end' : ''}`}>
              <div className="mb-0.5 text-xs font-medium text-white/70">
                {m.private ? <PrivateMark detail={privateDetail(m, known)} /> : <PublicMark />}
                <bdi>{sender}</bdi>
              </div>
              <p
                className={`w-fit max-w-full rounded-2xl bg-[#3c4043] px-3 py-2 text-white/95 wrap-anywhere ${m.self ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}
              >
                {m.text}
              </p>
              {m.self && m.notDeliveredTo?.length ? (
                <p role="status" className="mt-0.5 text-xs text-[#fdd663]">
                  {m.private
                    ? 'Not delivered.'
                    : `Not delivered to ${m.notDeliveredTo.map((r) => personTag(r.peerId, r.role, known)).join(', ')}.`}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {onSendFile && <SendFile onSend={onSendFile} />}
      <form
        data-testid="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (t && !gone) {
            if (to) onSend(t, to);
            else onSend(t);
            setText('');
          }
        }}
        className="p-3"
      >
        {(recipients.length > 1 || to !== '') && (
          <div className="mb-2 flex items-center gap-2 px-1">
            <label htmlFor="chat-to" className="shrink-0 text-sm text-white/70">
              To
            </label>
            <select
              id="chat-to"
              value={to}
              onChange={(e) => onTo?.(e.target.value)}
              aria-describedby={to ? 'chat-to-note' : undefined}
              className="min-h-11 min-w-0 flex-1 truncate rounded-lg bg-[#3c4043] px-2 text-base text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:min-h-9 sm:text-sm"
            >
              <option value="">Everyone</option>
              {gone && <option value={to}>Not available</option>}
              {labelled.map((r) => (
                <option key={r.peerId} value={r.peerId}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {gone ? (
          <p key="gone" id="chat-to-note" role="alert" className="mb-2 px-1 text-xs text-[#fdd663]">
            That person left the call or reconnected. Choose who to send to.
          </p>
        ) : person ? (
          <p key="note" id="chat-to-note" className="mb-2 px-1 text-xs text-white/70">
            Only {person.tag} (<bdi>{optionName(person.name)}</bdi>) gets it. It is left out of the
            recorded chat.
          </p>
        ) : null}
        {/* The input drops its own outline; the pill shows focus instead. */}
        <div className="flex items-center gap-2 rounded-full bg-[#3c4043] pl-4 pr-1.5 focus-within:ring-2 focus-within:ring-[#8ab4f8]">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_CHAT_MESSAGE_LENGTH}
            placeholder="Send a message"
            aria-label="Message"
            className="flex-1 bg-transparent py-2.5 text-base text-white placeholder:text-white/70 focus:outline-none sm:text-sm"
          />
          <button
            type="submit"
            aria-label="Send message"
            title="Send"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#8ab4f8] hover:bg-white/10 disabled:opacity-40 sm:h-8 sm:w-8"
            disabled={!text.trim() || gone}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </form>
    </aside>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import type { Role } from '@openmeet/protocol';
import { Icon } from './Icon';

export interface ChatMessage {
  from: Role;
  text: string;
  ts: number;
  fromPeerId?: string;
  fromName?: string;
  self?: boolean;
}

export function chatSenderLabel(m: Pick<ChatMessage, 'from' | 'fromName' | 'self'>): string {
  return m.self ? 'You' : (m.fromName || (m.from.charAt(0).toUpperCase() + m.from.slice(1)));
}

export function ChatPanel({
  messages,
  onSend,
  onClose,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
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
        {messages.length === 0 && (
          <p className="mt-4 text-center text-sm text-white/70">
            Messages are visible to everyone in the call.
          </p>
        )}
        {messages.map((m, i) => {
          const sender = chatSenderLabel(m);
          return (
            // Each bubble hugs its text, and your own sit on the right, so a
            // message never reads as a second text field.
            <div key={i} className={`text-sm ${m.self ? 'flex flex-col items-end' : ''}`}>
              <div className="mb-0.5 text-xs font-medium text-white/70">{sender}</div>
              <p
                className={`w-fit max-w-full rounded-2xl bg-[#3c4043] px-3 py-2 text-white/95 wrap-anywhere ${m.self ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}
              >
                {m.text}
              </p>
            </div>
          );
        })}
      </div>

      <form
        data-testid="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (t) {
            onSend(t);
            setText('');
          }
        }}
        className="p-3"
      >
        {/* The input drops its own outline; the pill shows focus instead. */}
        <div className="flex items-center gap-2 rounded-full bg-[#3c4043] pl-4 pr-1.5 focus-within:ring-2 focus-within:ring-[#8ab4f8]">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Send a message"
            aria-label="Message"
            className="flex-1 bg-transparent py-2.5 text-base text-white placeholder:text-white/70 focus:outline-none sm:text-sm"
          />
          <button
            type="submit"
            aria-label="Send message"
            title="Send"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#8ab4f8] hover:bg-white/10 disabled:opacity-40 sm:h-8 sm:w-8"
            disabled={!text.trim()}
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

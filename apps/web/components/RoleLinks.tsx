'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

// `query` is the flag RoomView reads from the address.
const LINKS = [
  {
    query: 'producer',
    title: 'Copy producer link',
    hint: 'Watches and chats. Never recorded.',
    copied: 'Producer link copied.',
  },
  {
    query: 'present',
    title: 'Copy Present-only link',
    hint: 'Shares a screen only. No camera or mic.',
    copied: 'Present-only link copied.',
  },
] as const;

type Link = (typeof LINKS)[number];

const LABEL = 'Other links';

/**
 * The two links that join with no camera or microphone, behind an arrow beside
 * the host's Copy invite link. Each says what happens to whoever opens it:
 * sent to a guest by mistake, either one joins that guest unrecorded.
 *
 * The caller places the panel (`menuClassName`) from the row the arrow sits
 * in, not from the arrow: the arrow moves as the label beside it changes, and
 * a panel hung from it would leave a phone's screen.
 */
export function RoleLinks({
  className = '',
  menuClassName,
}: {
  className?: string;
  menuClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ link: Link; ok: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Hand focus back to the arrow; otherwise it falls to <body> when the
      // button it was on unmounts.
      arrow.current?.focus();
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function copy(link: Link) {
    // origin+pathname is the plain invite link, whatever query this page has.
    const write = navigator.clipboard?.writeText(`${location.origin}${location.pathname}?${link.query}=1`);
    // No clipboard (plain-http self-host) or permission denied: say how to
    // build the link by hand, so the click never does nothing.
    if (!write) return setResult({ link, ok: false });
    write.then(
      () => setResult({ link, ok: true }),
      () => setResult({ link, ok: false })
    );
  }

  return (
    <div ref={root} className={`inline-flex ${className}`}>
      <button
        ref={arrow}
        type="button"
        onClick={() => {
          // What the last opening copied says nothing about this one.
          setResult(null);
          setOpen((o) => !o);
        }}
        aria-label={LABEL}
        title={LABEL}
        aria-expanded={open}
        className="inline-flex h-11 w-11 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
      >
        <Icon name="arrow_drop_down" size={22} />
      </button>
      {open && (
        <div
          role="group"
          aria-label={LABEL}
          className={`absolute z-[60] w-72 max-w-[calc(100vw-2rem)] rounded-xl bg-[#2a2b2e] p-1.5 text-left text-white shadow-2xl ring-1 ring-white/10 ${menuClassName}`}
        >
          {LINKS.map((link) => (
            <button
              key={link.query}
              type="button"
              onClick={() => copy(link)}
              className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
            >
              <span className="block text-sm">{link.title}</span>
              <span className="block text-xs leading-snug text-white/70">{link.hint}</span>
            </button>
          ))}
          {/* Mounted with the panel, and only its text changes, so a screen
              reader announces what a copy did. */}
          <p
            role="status"
            className={`mt-1 border-t border-white/10 px-3 pb-1.5 pt-2 text-xs leading-snug ${
              !result ? 'text-white/70' : result.ok ? 'text-[#81c995]' : 'text-[#fdd663]'
            }`}
          >
            {!result
              ? 'To record someone, send the invite link.'
              : result.ok
                ? result.link.copied
                : `Couldn’t copy. Add ?${result.link.query}=1 to this page’s address.`}
          </p>
        </div>
      )}
    </div>
  );
}

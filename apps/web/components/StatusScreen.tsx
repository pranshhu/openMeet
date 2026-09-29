'use client';

import type { ReactNode } from 'react';
import { SiteHeader } from './Logo';

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b57d0]';
const primary = `inline-flex items-center rounded-full bg-[#0b57d0] px-6 py-3 text-[15px] font-medium text-white shadow-sm transition-colors hover:bg-[#0842a0] ${focus}`;
const secondaryClass = `inline-flex items-center rounded-full border border-[#dadce0] bg-white px-6 py-3 text-[15px] font-medium text-[#0b57d0] transition-colors hover:bg-[#f8fafd] ${focus}`;

/**
 * Every light status screen: the site header (logo top-left, linking home),
 * what happened, and the next step. An action without an href reloads, which
 * lands back in the lobby with fresh devices.
 */
export function StatusScreen({
  children,
  title,
  action,
  href,
  spinner = false,
  secondary,
}: {
  children: ReactNode;
  title?: string;
  action?: string;
  href?: string;
  spinner?: boolean;
  secondary?: { label: string; href: string };
}) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-white text-[#202124]">
      <SiteHeader />
      <main className="flex flex-1 items-center justify-center px-4 pb-[12vh] pt-10 text-center sm:px-6">
        <div className="flex w-full max-w-md flex-col items-center" role={spinner ? 'status' : undefined}>
          {spinner && (
            <span
              aria-hidden
              className="mb-6 h-8 w-8 animate-spin rounded-full border-[3px] border-[#0b57d0]/25 border-t-[#0b57d0] motion-reduce:animate-none"
            />
          )}
          {title && <h1 className="text-[28px] font-normal leading-tight tracking-tight">{title}</h1>}
          <div className={`text-balance text-[15px] leading-relaxed text-[#5f6368] ${title ? 'mt-3' : ''}`}>{children}</div>
          {(action || secondary) && (
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              {action &&
                (href ? (
                  <a className={primary} href={href}>
                    {action}
                  </a>
                ) : (
                  <button type="button" className={primary} onClick={() => window.location.reload()}>
                    {action}
                  </button>
                ))}
              {secondary && (
                <a className={secondaryClass} href={secondary.href}>
                  {secondary.label}
                </a>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

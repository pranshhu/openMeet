'use client';

export function Logo({
  tone = 'dark',
  className = '',
}: {
  tone?: 'light' | 'dark';
  className?: string;
}) {
  const isDark = tone === 'dark';
  return (
    <span
      className={`text-[22px] font-medium tracking-tight ${isDark ? 'text-white' : 'text-[#202124]'} ${className}`}
    >
      open<span className={isDark ? 'text-[#8ab4f8]' : 'text-[#0b57d0]'}>Meet</span>
    </span>
  );
}

/** The light pages' header: the logo top-left, exactly where the landing page puts it, linking home. */
export function SiteHeader() {
  return (
    <header className="px-4 pt-[18px] min-[861px]:px-14 min-[861px]:pt-7">
      <a
        href="/"
        aria-label="openMeet home"
        className="inline-block rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#0b57d0]"
      >
        <Logo tone="light" />
      </a>
    </header>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { createRoom, getSponsors } from '@/lib/api';
import type { SponsorsResponse } from '@/lib/api';
import { storeHostToken } from '@/lib/host-token';
import { Logo } from '@/components/Logo';
import { SponsorWall } from '@/components/SponsorWall';

export default function Landing() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sponsorsData, setSponsorsData] = useState<SponsorsResponse | null>(null);
  const [sponsored, setSponsored] = useState(false);

  useEffect(() => {
    let active = true;
    if (typeof getSponsors === 'function') {
      getSponsors()
        .then((data) => {
          if (active && data && data.checkoutUrl) {
            setSponsorsData(data);
          }
        })
        .catch(() => {
          if (active) setSponsorsData(null);
        });
    }

    if (typeof window !== 'undefined') {
      setSponsored(new URLSearchParams(window.location.search).get('sponsored') === '1');
    }

    return () => {
      active = false;
    };
  }, []);

  async function onNewRoom() {
    setBusy(true);
    setError(null);
    try {
      const { slug, host_token } = await createRoom();
      storeHostToken(slug, host_token);
      window.location.href = `/r/${slug}/`;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create room');
      setBusy(false);
    }
  }

  // Plain landing page when sponsors are not configured
  if (!sponsorsData || !sponsorsData.checkoutUrl) {
    return (
      <div className="flex min-h-screen flex-col bg-white text-[#202124]">
        <header className="px-6 py-5 sm:px-10">
          <Logo tone="light" />
        </header>

        <main className="flex flex-1 items-center px-6 sm:px-10">
          <div className="mx-auto w-full max-w-2xl text-center sm:mx-0 sm:max-w-xl sm:text-left">
            <h1 className="text-4xl font-normal leading-[1.15] tracking-tight text-[#202124] sm:text-[3.25rem]">
              Studio-quality remote recording
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-[#5f6368]">
              Record studio-quality remote interviews in the browser. Each person’s track is captured
              locally and saved straight to the host’s disk — zero cloud storage.
            </p>

            <div className="mt-9 flex flex-col items-center gap-4 sm:flex-row sm:items-center">
              <button
                onClick={onNewRoom}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-full bg-[#0b57d0] px-7 py-3.5 text-[15px] font-medium text-white shadow-sm transition-colors hover:bg-[#0842a0] disabled:opacity-50"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
                </svg>
                {busy ? 'Creating…' : 'New Room'}
              </button>
              <span className="text-sm text-[#5f6368]">Share the link — up to four people recorded.</span>
            </div>

            {error && <p className="mt-5 text-sm text-[#ea4335]">{error}</p>}
          </div>
        </main>

        <footer className="px-6 py-5 text-xs text-[#5f6368] sm:px-10">
          <a
            href="https://github.com/pranshhu/openMeet"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#5f6368] hover:underline"
          >
            open-source
          </a>
          {' · self-hostable · MIT licensed'}
        </footer>
      </div>
    );
  }

  // Sponsor wall landing page: two columns on desktop, stacked on mobile
  return (
    <div className="page">
      <header className="head">
        <a className="logo" href="/">
          open<span>Meet</span>
        </a>
      </header>

      <main className="main">
        <div className="hero">
          {sponsored && (
            <p className="mb-4 text-sm font-medium text-[#137333] bg-[#e6f4ea] px-3.5 py-2 rounded-lg">
              Thank you! Your logo appears here once it&apos;s approved.
            </p>
          )}

          <h1>Studio-quality remote recording</h1>
          <p className="lede">
            Record studio-quality remote interviews in the browser. Each person’s track is captured
            locally and saved straight to the host’s disk — zero cloud storage.
          </p>

          <div className="cta">
            <button
              onClick={onNewRoom}
              disabled={busy}
              className="btn"
              type="button"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
              </svg>
              {busy ? 'Creating…' : 'New Room'}
            </button>
            <span className="helper">Share the link — up to four people recorded.</span>
          </div>

          {error && <p className="mt-5 text-sm text-[#ea4335]">{error}</p>}
        </div>
      </main>

      <aside className="side" aria-labelledby="wall-title">
        <SponsorWall
          sponsors={sponsorsData.sponsors}
          available={sponsorsData.available}
          checkoutUrl={sponsorsData.checkoutUrl}
        />
      </aside>

      <footer className="foot">
        <a
          href="https://github.com/pranshhu/openMeet"
          target="_blank"
          rel="noopener noreferrer"
        >
          open-source
        </a>
        {' · self-hostable · MIT licensed · '}
        <a
          className="sponsor-link checkout"
          href={sponsorsData.checkoutUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Sponsor openMeet
        </a>
      </footer>
    </div>
  );
}


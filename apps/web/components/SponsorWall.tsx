'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import type { Sponsor } from '@/lib/api';
import type { TreemapRect } from '@/lib/treemap';
import { layoutSponsorWall, isOpenCell } from '@/lib/treemap';

export interface SponsorWallProps {
  sponsors: Sponsor[];
  available: number;
  checkoutUrl: string | null;
  bounds?: { w: number; h: number };
}

const TINTS: readonly [string, string][] = [
  ['#d3e3fd', '#041e49'],
  ['#c4eed0', '#072711'],
  ['#ffe8b3', '#3d2a00'],
  ['#f2dcff', '#2e0a4d'],
];

interface TileProps {
  rect: TreemapRect<Sponsor>;
  tintIndex: number;
  gap: number;
}

function SponsorTile({ rect, tintIndex, gap }: TileProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const s = rect.item;
  const inset = gap / 2;
  const w = Math.max(0, rect.w - gap);
  const h = Math.max(0, rect.h - gap);
  const left = rect.x + inset;
  const top = rect.y + inset;

  const [bg, fg] = TINTS[tintIndex % TINTS.length]!;

  const style: React.CSSProperties = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${w}px`,
    height: `${h}px`,
  };

  const showLogo = Boolean(s.logo && !imgFailed && w >= 30 && h >= 18);
  const accessibleName = `Sponsor: ${s.name}`;

  let content: React.ReactNode = null;
  if (showLogo) {
    content = (
      <img
        src={s.logo!}
        alt={s.name}
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
      />
    );
  } else if (w >= 30 && h >= 18) {
    const fontSize = Math.max(
      11,
      Math.min(26, w / (s.name.length * 0.72), h * 0.3)
    );
    content = <span style={{ fontSize: `${fontSize}px` }}>{s.name}</span>;
  }

  const className = `tile ${showLogo ? 'logo' : ''}`;
  const tileStyle: React.CSSProperties = showLogo
    ? style
    : { ...style, background: bg, color: fg };

  if (s.url) {
    return (
      <a
        href={s.url}
        target="_blank"
        rel="sponsored noopener noreferrer"
        className={className}
        style={tileStyle}
        title={accessibleName}
        aria-label={accessibleName}
      >
        {content}
      </a>
    );
  }

  return (
    <div
      className={className}
      style={tileStyle}
      title={accessibleName}
      aria-label={accessibleName}
    >
      {content}
    </div>
  );
}

export function SponsorWall({
  sponsors,
  available,
  checkoutUrl,
  bounds,
}: SponsorWallProps) {
  const wallRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);

  const [size, setSize] = useState<{ w: number; h: number }>(() => {
    if (bounds) return bounds;
    return { w: 600, h: 700 };
  });

  useEffect(() => {
    if (bounds) {
      setSize(bounds);
      return;
    }

    const updateSize = () => {
      if (wallRef.current) {
        const rect = wallRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setSize({ w: rect.width, h: rect.height });
        }
      }
    };

    updateSize();

    if (typeof ResizeObserver !== 'undefined' && wallRef.current) {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cr = entry.contentRect;
          if (cr.width > 0 && cr.height > 0) {
            setSize({ w: cr.width, h: cr.height });
          }
        }
      });
      ro.observe(wallRef.current);
      return () => ro.disconnect();
    }
  }, [bounds]);

  const layout = useMemo(
    () => layoutSponsorWall(sponsors, size.w, size.h),
    [sponsors, size.w, size.h]
  );

  const { cols, rows, pitch, gap, ox, oy, region, openRect, tiles } = layout;
  const empty = !region;
  const hasOpen =
    cols > 0 &&
    rows > 0 &&
    (!region || region.cols * region.rows < cols * rows);

  const gridD = `M ${ox} ${oy} h ${cols * pitch} v ${rows * pitch} h ${-(cols * pitch)} Z`;
  const pathD = region
    ? `${gridD} M ${ox + region.c * pitch} ${oy + region.r * pitch} h ${region.cols * pitch} v ${region.rows * pitch} h ${-(region.cols * pitch)} Z`
    : gridD;

  const handleMouseMove = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!hlRef.current || !wallRef.current) return;
    const b = wallRef.current.getBoundingClientRect();
    const c = Math.floor((e.clientX - b.left - ox) / pitch);
    const r = Math.floor((e.clientY - b.top - oy) / pitch);
    const target = e.target as HTMLElement | null;
    const inside = isOpenCell(layout, c, r) && !target?.closest('.chip');
    if (inside) {
      hlRef.current.style.display = 'block';
      hlRef.current.style.left = `${ox + c * pitch + gap / 2}px`;
      hlRef.current.style.top = `${oy + r * pitch + gap / 2}px`;
    } else {
      hlRef.current.style.display = 'none';
    }
  };

  const handleMouseLeave = () => {
    if (hlRef.current) {
      hlRef.current.style.display = 'none';
    }
  };

  return (
    <section className="panel" aria-label="Sponsors">
      <div className="panel-head">
        <h2 id="wall-title">
          Sponsors ·{' '}
          <a
            className="checkout"
            href={checkoutUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
          >
            Your logo here
          </a>
        </h2>
        <span className="open-count">
          <i className="swatch" aria-hidden="true" />
          <span>{`${Math.round(available * 100)}% open`}</span>
        </span>
      </div>

      <div className="wall" ref={wallRef}>
        <a
          className="open"
          href={checkoutUrl ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Sponsor openMeet — your logo here"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {hasOpen && (
            <>
              <svg width="100%" height="100%" aria-hidden="true">
                <defs>
                  <pattern
                    id="cellpat"
                    width={pitch}
                    height={pitch}
                    patternUnits="userSpaceOnUse"
                    x={ox}
                    y={oy}
                  >
                    <rect
                      className="c"
                      x={gap / 2}
                      y={gap / 2}
                      width={pitch - gap}
                      height={pitch - gap}
                      rx="3"
                    />
                  </pattern>
                </defs>
                <path
                  fillRule="evenodd"
                  fill="url(#cellpat)"
                  d={pathD}
                />
              </svg>
              <div
                ref={hlRef}
                className="hl"
                style={{
                  width: `${pitch - gap}px`,
                  height: `${pitch - gap}px`,
                }}
              />
              {empty ? (
                <div
                  className="chip big"
                  style={{
                    left: `${openRect.x + openRect.w / 2}px`,
                    top: `${openRect.y + openRect.h / 2}px`,
                  }}
                >
                  <b>Your logo here</b>
                  <small>Be the first sponsor. Your tile grows with your support.</small>
                  <span className="go">Sponsor openMeet →</span>
                </div>
              ) : openRect.w >= 220 && openRect.h >= 110 ? (
                <div
                  className="chip"
                  style={{
                    left: `${openRect.x + openRect.w / 2}px`,
                    top: `${openRect.y + openRect.h / 2}px`,
                  }}
                >
                  <b>Your logo here</b>
                  <small>Claim open cells on this wall</small>
                  <span className="go">Sponsor openMeet →</span>
                </div>
              ) : openRect.w >= 130 && openRect.h >= 40 ? (
                <div
                  className="chip tiny"
                  style={{
                    left: `${openRect.x + openRect.w / 2}px`,
                    top: `${openRect.y + openRect.h / 2}px`,
                  }}
                >
                  <b>Your logo here →</b>
                </div>
              ) : null}
            </>
          )}
        </a>

        {tiles.map((rect, idx) => (
          <SponsorTile
            key={`${rect.item.name}-${idx}`}
            rect={rect}
            tintIndex={idx}
            gap={gap}
          />
        ))}
      </div>

      <p className="panel-foot">Tile size is proportional to support. Every open cell is available.</p>
    </section>
  );
}


export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapRect<T = unknown> {
  x: number;
  y: number;
  w: number;
  h: number;
  item: T;
}

export interface SquarifyEntry<T> {
  item: T;
  weight: number;
}

function worstRatio(row: { area: number }[], length: number): number {
  if (row.length === 0 || length <= 0) return Infinity;
  const s = row.reduce((sum, r) => sum + r.area, 0);
  if (s <= 0) return Infinity;
  const s2 = s * s;
  const l2 = length * length;
  let worst = 0;
  for (const r of row) {
    if (r.area <= 0) continue;
    const ratio = Math.max((l2 * r.area) / s2, s2 / (l2 * r.area));
    if (ratio > worst) worst = ratio;
  }
  return worst;
}

/**
 * Standard squarified treemap algorithm (Bruls, Huizing, van Wijk).
 * Sorts items by weight descending and lays them out to approximate square aspect ratios.
 */
export function squarify<T>(
  items: SquarifyEntry<T>[],
  rect: Rect
): TreemapRect<T>[];
export function squarify<T extends { weight: number }>(
  items: T[],
  rect: Rect
): TreemapRect<T>[];
export function squarify<T>(
  items: (SquarifyEntry<T> | (T & { weight: number }))[],
  rect: Rect
): TreemapRect<T>[] {
  const rx = rect.x;
  const ry = rect.y;
  const rw = rect.w;
  const rh = rect.h;

  if (rw <= 0 || rh <= 0 || items.length === 0) {
    return [];
  }

  const normalized: SquarifyEntry<T>[] = items.map((entry) => {
    if ('item' in entry) {
      return entry;
    }
    return { item: entry as unknown as T, weight: entry.weight };
  });

  const sorted = [...normalized].sort((a, b) => b.weight - a.weight);
  const totalWeight = sorted.reduce((sum, it) => sum + it.weight, 0);
  if (totalWeight <= 0) return [];

  const totalArea = rw * rh;
  const itemsWithArea = sorted.map((it) => ({
    item: it.item,
    area: (it.weight / totalWeight) * totalArea,
  }));

  const out: TreemapRect<T>[] = [];
  let curX = rx;
  let curY = ry;
  let curW = rw;
  let curH = rh;

  function layoutRow(row: { item: T; area: number }[]) {
    if (row.length === 0) return;
    const rowArea = row.reduce((sum, r) => sum + r.area, 0);
    const isHorizontal = curW < curH;

    if (isHorizontal) {
      const rowHeight = rowArea / curW;
      let x = curX;
      for (let i = 0; i < row.length; i++) {
        const entry = row[i]!;
        const itemWidth = i === row.length - 1 ? curX + curW - x : entry.area / rowHeight;
        out.push({
          x,
          y: curY,
          w: itemWidth,
          h: rowHeight,
          item: entry.item,
        });
        x += itemWidth;
      }
      curY += rowHeight;
      curH -= rowHeight;
    } else {
      const rowWidth = rowArea / curH;
      let y = curY;
      for (let i = 0; i < row.length; i++) {
        const entry = row[i]!;
        const itemHeight = i === row.length - 1 ? curY + curH - y : entry.area / rowWidth;
        out.push({
          x: curX,
          y,
          w: rowWidth,
          h: itemHeight,
          item: entry.item,
        });
        y += itemHeight;
      }
      curX += rowWidth;
      curW -= rowWidth;
    }
  }

  let currentRow: { item: T; area: number }[] = [];

  for (const entry of itemsWithArea) {
    const shortestSide = Math.min(curW, curH);
    if (currentRow.length === 0) {
      currentRow.push(entry);
    } else {
      const currentWorst = worstRatio(currentRow, shortestSide);
      const nextWorst = worstRatio([...currentRow, entry], shortestSide);
      if (nextWorst <= currentWorst) {
        currentRow.push(entry);
      } else {
        layoutRow(currentRow);
        currentRow = [entry];
      }
    }
  }

  if (currentRow.length > 0) {
    layoutRow(currentRow);
  }

  return out;
}

export interface WallLayout<T> {
  cols: number;
  rows: number;
  pitch: number;
  gap: number;
  ox: number;
  oy: number;
  region: { c: number; r: number; cols: number; rows: number } | null;
  open: { c: number; r: number; cols: number; rows: number };
  openRect: Rect;
  tiles: TreemapRect<T>[];
}

/**
 * Lays out sponsor wall in cell-snapped grid cells.
 * Claimed region: a full-width band across the top, or a top-left block
 * when the band would be thinner than 5 rows.
 * Treemap tiles are placed in whole grid cells scaled proportionally.
 */
export function layoutSponsorWall<T extends { weight: number }>(
  sponsors: T[],
  widthOrBounds: number | { w: number; h: number },
  maybeHeight?: number
): WallLayout<T> {
  const W = typeof widthOrBounds === 'number' ? widthOrBounds : widthOrBounds.w;
  const H = typeof widthOrBounds === 'number' ? maybeHeight ?? 0 : widthOrBounds.h;

  const p = W < 480 ? 14 : 16;
  const gap = 3;
  const cols = Math.max(0, Math.floor(W / p));
  const rows = Math.max(0, Math.floor(H / p));
  const ox = Math.floor((W - cols * p) / 2);
  const oy = Math.floor((H - rows * p) / 2);

  const px = (g: { c: number; r: number; cols: number; rows: number }): Rect => ({
    x: ox + g.c * p,
    y: oy + g.r * p,
    w: g.cols * p,
    h: g.rows * p,
  });

  const total = sponsors.reduce((a, s) => a + s.weight, 0);

  if (cols < 1 || rows < 1 || sponsors.length === 0 || total <= 0) {
    const open = { c: 0, r: 0, cols, rows };
    return {
      cols,
      rows,
      pitch: p,
      gap,
      ox,
      oy,
      region: null,
      open,
      openRect: px(open),
      tiles: [],
    };
  }

  // Claimed region, snapped to whole cells: a full-width band on top, or a
  // top-left block when the band would be thinner than 5 rows. Rounding up to
  // whole cells scales every tile by the same factor, so area stays proportional.
  const S = Math.min(total, 1) * cols * rows;
  let rc = cols;
  let rr = Math.ceil(S / cols);
  if (rr < 5) {
    rr = Math.max(1, Math.round(Math.sqrt(S)));
    rc = Math.min(cols, Math.ceil(S / rr));
  }
  rr = Math.min(rr, rows);

  const region = { c: 0, r: 0, cols: rc, rows: rr };
  const open =
    rc === cols
      ? { c: 0, r: rr, cols, rows: rows - rr }
      : { c: rc, r: 0, cols: cols - rc, rows };

  const R = px(region);
  const sorted = [...sponsors].sort((a, b) => b.weight - a.weight);
  const tiles = squarify(sorted, R);

  return {
    cols,
    rows,
    pitch: p,
    gap,
    ox,
    oy,
    region,
    open,
    openRect: px(open),
    tiles,
  };
}

/**
 * Returns true if the cell (c, r) is inside the wall grid and not inside the claimed region.
 */
export function isOpenCell<T = unknown>(
  layout: Pick<WallLayout<T>, 'cols' | 'rows' | 'region'>,
  c: number,
  r: number
): boolean {
  if (c < 0 || c >= layout.cols || r < 0 || r >= layout.rows) {
    return false;
  }
  if (!layout.region) {
    return true;
  }
  const { c: rc, r: rr, cols: rcols, rows: rrows } = layout.region;
  return !(c >= rc && c < rc + rcols && r >= rr && r < rr + rrows);
}


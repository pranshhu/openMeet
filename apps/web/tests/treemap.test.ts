import { describe, it, expect } from 'vitest';
import { squarify, layoutSponsorWall, isOpenCell } from '@/lib/treemap';
import type { Rect } from '@/lib/treemap';

function rectsOverlap(r1: Rect, r2: Rect): number {
  const xOverlap = Math.max(0, Math.min(r1.x + r1.w, r2.x + r2.w) - Math.max(r1.x, r2.x));
  const yOverlap = Math.max(0, Math.min(r1.y + r1.h, r2.y + r2.h) - Math.max(r1.y, r2.y));
  return xOverlap * yOverlap;
}

describe('treemap — squarify', () => {
  it('squarify areas ∝ weights (±1%), no overlaps, all inside the rect', () => {
    const container: Rect = { x: 0, y: 0, w: 1000, h: 1000 };
    const containerArea = container.w * container.h;
    const items = [
      { name: 'Alpha', weight: 6 },
      { name: 'Beta', weight: 3 },
      { name: 'Gamma', weight: 1 },
    ];
    const totalWeight = 10;

    const rects = squarify(items, container);
    expect(rects).toHaveLength(3);

    // 1. Areas proportional to weights (±1%)
    for (const r of rects) {
      const area = r.w * r.h;
      const expectedArea = (r.item.weight / totalWeight) * containerArea;
      const ratio = area / expectedArea;
      expect(ratio).toBeGreaterThanOrEqual(0.99);
      expect(ratio).toBeLessThanOrEqual(1.01);
    }

    // 2. No overlaps
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const overlap = rectsOverlap(rects[i]!, rects[j]!);
        expect(overlap).toBeLessThan(0.01);
      }
    }

    // 3. All inside the rect
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(container.x - 0.01);
      expect(r.y).toBeGreaterThanOrEqual(container.y - 0.01);
      expect(r.x + r.w).toBeLessThanOrEqual(container.x + container.w + 0.01);
      expect(r.y + r.h).toBeLessThanOrEqual(container.y + container.h + 0.01);
    }
  });

  it('handles non-square containers and many items', () => {
    const container: Rect = { x: 100, y: 50, w: 1200, h: 600 };
    const containerArea = container.w * container.h;
    const items = [
      { name: 'A', weight: 40 },
      { name: 'B', weight: 25 },
      { name: 'C', weight: 15 },
      { name: 'D', weight: 10 },
      { name: 'E', weight: 7 },
      { name: 'F', weight: 3 },
    ];
    const totalWeight = 100;

    const rects = squarify(items, container);
    expect(rects).toHaveLength(6);

    for (const r of rects) {
      const area = r.w * r.h;
      const expectedArea = (r.item.weight / totalWeight) * containerArea;
      const ratio = area / expectedArea;
      expect(ratio).toBeGreaterThanOrEqual(0.99);
      expect(ratio).toBeLessThanOrEqual(1.01);
    }

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!, rects[j]!)).toBeLessThan(0.01);
      }
    }
  });
});

describe('cell-snapped layout', () => {
  const sponsors = [
    { name: 'Acme Studios', weight: 0.30 },
    { name: 'PodCo', weight: 0.12 },
    { name: 'MicWorks', weight: 0.07 },
    { name: 'Lumen Audio', weight: 0.05 },
    { name: 'Tiny FM', weight: 0.025 },
    { name: 'Echo Labs', weight: 0.02 },
  ];

  it('cell-snapped layout keeps every sponsor area/weight equal within 5% at 1440x900', () => {
    const layout = layoutSponsorWall(sponsors, 1440, 900);
    expect(layout.tiles).toHaveLength(sponsors.length);

    const ratios = layout.tiles.map((t) => (t.w * t.h) / t.item.weight);
    const minRatio = Math.min(...ratios);
    const maxRatio = Math.max(...ratios);

    expect((maxRatio - minRatio) / minRatio).toBeLessThan(0.05);
  });

  it('cell-snapped layout keeps every sponsor area/weight equal within 5% at 390x844', () => {
    const layout = layoutSponsorWall(sponsors, 390, 844);
    expect(layout.tiles).toHaveLength(sponsors.length);

    const ratios = layout.tiles.map((t) => (t.w * t.h) / t.item.weight);
    const minRatio = Math.min(...ratios);
    const maxRatio = Math.max(...ratios);

    expect((maxRatio - minRatio) / minRatio).toBeLessThan(0.05);
  });

  it('handles empty sponsors list with full open space', () => {
    const layout = layoutSponsorWall([], 1440, 900);
    expect(layout.tiles).toHaveLength(0);
    expect(layout.region).toBeNull();
    expect(layout.open.cols).toBe(layout.cols);
    expect(layout.open.rows).toBe(layout.rows);
  });
});

describe('isOpenCell', () => {
  it('identifies open cells in block layout with one sponsor', () => {
    const layout = layoutSponsorWall([{ name: 'Solo', weight: 0.025 }], 1440, 900);
    expect(layout.region).not.toBeNull();
    const region = layout.region!;

    // A cell inside the region is not open
    expect(isOpenCell(layout, 0, 0)).toBe(false);
    expect(isOpenCell(layout, region.cols - 1, region.rows - 1)).toBe(false);

    // A cell directly below the region is open
    expect(isOpenCell(layout, 0, region.rows)).toBe(true);

    // A cell to the right of the region is open
    expect(isOpenCell(layout, region.cols, 0)).toBe(true);

    // Cells outside grid boundaries are not open
    expect(isOpenCell(layout, -1, 0)).toBe(false);
    expect(isOpenCell(layout, 0, -1)).toBe(false);
    expect(isOpenCell(layout, layout.cols, 0)).toBe(false);
    expect(isOpenCell(layout, 0, layout.rows)).toBe(false);
  });

  it('all cells in grid are open when there are no sponsors', () => {
    const layout = layoutSponsorWall([], 1440, 900);
    expect(isOpenCell(layout, 0, 0)).toBe(true);
    expect(isOpenCell(layout, layout.cols - 1, layout.rows - 1)).toBe(true);
    expect(isOpenCell(layout, -1, 0)).toBe(false);
  });
});


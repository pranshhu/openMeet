import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('icon.svg', () => {
  it('does not contain the byline paths and has tightened viewBox', () => {
    const svgPath = path.resolve(__dirname, '../public/icon.svg');
    const content = fs.readFileSync(svgPath, 'utf8');
    expect(content).not.toMatch(/#5[Ff]6368/);
    expect(content).not.toMatch(/viewBox="0 0 341 103"/);
    expect(content).toMatch(/viewBox="0 0 341 86"/);
  });
});

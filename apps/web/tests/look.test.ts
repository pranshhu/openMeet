import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { lookFrom, logoFrom, readLook, saveLook } from '@/lib/look';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('lookFrom', () => {
  it('keeps an accent on the list', () => {
    expect(lookFrom({ accent: 'red' })).toEqual({ accent: 'red' });
    expect(lookFrom({ type: 'look', accent: 'pink', extra: 1 })).toEqual({ accent: 'pink' });
  });

  it('gives the plain look for anything else, and never throws', () => {
    for (const v of [
      {},
      { accent: 'orange' },
      { accent: 'url(x)' },
      { accent: 7 },
      { accent: null },
      { accent: ['red'] },
      'red',
      7,
      null,
      undefined,
      [],
    ]) {
      expect(lookFrom(v)).toEqual({});
    }
  });
});

describe('the host look kept for a room', () => {
  it('reads back what was saved, per room', () => {
    saveLook('aaa-bbbb-ccc', { accent: 'green' });
    saveLook('ddd-eeee-fff', { accent: 'yellow' });
    expect(readLook('aaa-bbbb-ccc')).toEqual({ accent: 'green' });
    expect(readLook('ddd-eeee-fff')).toEqual({ accent: 'yellow' });
    expect(readLook('ggg-hhhh-iii')).toEqual({});
  });

  it('keeps the look in storage under the room, as the page reads it back', () => {
    saveLook('yyy-zzzz-aaa', { accent: 'pink' });
    expect(localStorage.getItem('om_look_yyy-zzzz-aaa')).toBe('{"accent":"pink"}');
    localStorage.setItem('om_look_yyy-zzzz-aaa', '{"accent":"blue"}');
    expect(readLook('yyy-zzzz-aaa')).toEqual({ accent: 'blue' });
  });

  it('reads a choice taken back as the plain look', () => {
    saveLook('jjj-kkkk-lll', { accent: 'blue' });
    saveLook('jjj-kkkk-lll', {});
    expect(readLook('jjj-kkkk-lll')).toEqual({});
  });

  it('reads the plain look when storage holds broken JSON or a bad accent', () => {
    localStorage.setItem('om_look_mmm-nnnn-ooo', '{not json');
    expect(readLook('mmm-nnnn-ooo')).toEqual({});
    localStorage.setItem('om_look_ppp-qqqq-rrr', JSON.stringify({ accent: 'url(x)' }));
    expect(readLook('ppp-qqqq-rrr')).toEqual({});
  });

  it('still reads a saved look when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    saveLook('sss-tttt-uuu', { accent: 'purple' });
    expect(readLook('sss-tttt-uuu')).toEqual({ accent: 'purple' });
    expect(readLook('vvv-wwww-xxx')).toEqual({});
  });
});

// The first 24 bytes of a PNG: signature, the IHDR chunk header, width, height.
function logoOf(width: number, height: number): string {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height)];
  return 'data:image/png;base64,' + btoa(String.fromCharCode(...head)) + 'AAAA';
}

describe('the logo of a look', () => {
  it('keeps a good logo in lookFrom and drops a bad one, keeping the accent', () => {
    const logo = logoOf(40, 20);
    expect(lookFrom({ accent: 'red', logo })).toEqual({ accent: 'red', logo });
    expect(lookFrom({ logo })).toEqual({ logo });
    for (const bad of [logoOf(20000, 20000), 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'url(x)', 7, null, {}, ['x']]) {
      expect(lookFrom({ accent: 'red', logo: bad })).toEqual({ accent: 'red' });
      expect(lookFrom({ logo: bad })).toEqual({});
    }
  });

  it('saves and reads back a logo, in storage and when storage throws', () => {
    const logo = logoOf(160, 80);
    saveLook('lll-llll-lll', { accent: 'blue', logo });
    expect(readLook('lll-llll-lll')).toEqual({ accent: 'blue', logo });
    expect(JSON.parse(localStorage.getItem('om_look_lll-llll-lll')!)).toEqual({ accent: 'blue', logo });

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    saveLook('mmm-mmmm-mmm', { logo });
    expect(readLook('mmm-mmmm-mmm')).toEqual({ logo });
  });

  it('reads a stored logo that is not a logo as no logo', () => {
    localStorage.setItem('om_look_nnn-nnnn-nnn', JSON.stringify({ accent: 'pink', logo: 'data:image/png;base64,AAAA' }));
    expect(readLook('nnn-nnnn-nnn')).toEqual({ accent: 'pink' });
  });
});

describe('logoFrom', () => {
  const file = new File(['x'], 'logo.png', { type: 'image/png' });
  let drawn: unknown[][];
  let closed: number;

  function stubPicture(width: number, height: number) {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width, height, close: () => void closed++ }),
    );
  }

  beforeEach(() => {
    drawn = [];
    closed = 0;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage: (...args: unknown[]) => drawn.push(args),
    })) as never);
    // The redrawn picture, as a PNG whose header holds the canvas size.
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
      this: HTMLCanvasElement,
      type?: string,
    ) {
      return type === 'image/png' ? logoOf(this.width, this.height) : 'data:image/jpeg;base64,/9j/4AAQ';
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scales 640 by 320 down to 160 by 80, drawn whole', async () => {
    stubPicture(640, 320);
    expect(await logoFrom(file)).toBe(logoOf(160, 80));
    expect(drawn).toEqual([[expect.objectContaining({ width: 640, height: 320 }), 0, 0, 160, 80]]);
    expect(closed).toBe(1);
  });

  it('scales a tall picture by its height', async () => {
    stubPicture(100, 400);
    expect(await logoFrom(file)).toBe(logoOf(40, 160));
  });

  it('keeps a very wide picture one pixel high', async () => {
    stubPicture(1600, 4);
    expect(await logoFrom(file)).toBe(logoOf(160, 1));
  });

  it('leaves 80 by 40 alone, and never scales up', async () => {
    stubPicture(80, 40);
    expect(await logoFrom(file)).toBe(logoOf(80, 40));
    expect(drawn).toEqual([[expect.objectContaining({ width: 80, height: 40 }), 0, 0, 80, 40]]);
  });

  it('gives null when decoding rejects', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('not a picture')));
    expect(await logoFrom(file)).toBeNull();
  });

  it('gives null when the redrawn picture is not a logo', async () => {
    stubPicture(80, 40);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
    expect(await logoFrom(file)).toBeNull();
  });

  it('gives null when the canvas has no 2d context', async () => {
    stubPicture(80, 40);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(await logoFrom(file)).toBeNull();
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { lookFrom, readLook, saveLook } from '@/lib/look';

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

import { describe, it, expect } from 'vitest';
import { buildSyncReport, type SyncReportInput } from '@/lib/sync-report';

const take: SyncReportInput = {
  recordingId: 'rec',
  hostFile: 'host_rec.mp4',
  hostWavFile: 'host_rec.wav',
  hostStartMs: 1000,
  guests: [
    { slot: 0, name: 'Bob', file: 'guest_rec.mp4', wavFile: 'guest_rec.wav', startHostMs: 1500, rttMs: 10 },
    { slot: 1, name: 'Carol', file: 'guest2_rec.mp4', startHostMs: 1600, rttMs: 10 },
  ],
};

/** The section of sync.json, and each summary row's detail by file name. */
function noted(input: SyncReportInput) {
  const report = buildSyncReport(input);
  const json = JSON.parse(report.json) as { echoCancellation?: { note: string; files: string[] } };
  const details = Object.fromEntries(report.data.fileList.map((f) => [f.name, f.detail]));
  return { json, details, warnings: report.data.warnings };
}

describe('buildSyncReport: echo cancellation', () => {
  it('marks both files of a guest slot and leaves everyone else alone', () => {
    const { json, details, warnings } = noted({ ...take, echoCancelled: { slots: [0] } });
    expect(json.echoCancellation?.files).toEqual(['guest_rec.mp4', 'guest_rec.wav']);
    expect(json.echoCancellation?.note).toMatch(/processed, not raw/);
    expect(details).toEqual({
      'host_rec.mp4': undefined,
      'guest_rec.mp4': 'echo cancellation on',
      'guest2_rec.mp4': undefined,
      'host_rec.wav': undefined,
      'guest_rec.wav': 'echo cancellation on',
    });
    // A choice, not a fault: it adds no warning.
    expect(warnings.join(' ')).not.toMatch(/echo/i);
  });

  it("marks the host's own camera and audio files", () => {
    const { json, details } = noted({ ...take, echoCancelled: { host: true } });
    expect(json.echoCancellation?.files).toEqual(['host_rec.mp4', 'host_rec.wav']);
    expect(details['host_rec.mp4']).toBe('echo cancellation on');
    expect(details['host_rec.wav']).toBe('echo cancellation on');
    expect(details['guest_rec.mp4']).toBeUndefined();
  });

  it('names only the camera file of a guest who has no audio master', () => {
    expect(noted({ ...take, echoCancelled: { slots: [1] } }).json.echoCancellation?.files).toEqual([
      'guest2_rec.mp4',
    ]);
  });

  it('writes no section and no detail when nobody had it on', () => {
    for (const echoCancelled of [undefined, {}, { host: false, slots: [] }, { slots: [7] }]) {
      const { json, details } = noted({ ...take, echoCancelled });
      expect('echoCancellation' in json).toBe(false);
      expect(Object.values(details).every((d) => d === undefined)).toBe(true);
    }
  });

  it("adds to a resumed host file's detail, and leaves the part before the reload unmarked", () => {
    const { json, details } = noted({
      ...take,
      hostFile: 'host_rec_resumed.mp4',
      hostWavFile: 'host_rec_resumed.wav',
      resumed: true,
      hostParts: [
        { name: 'host_rec.mp4', offsetMs: 0, kind: 'camera' },
        { name: 'host_rec_resumed.mp4', offsetMs: 5000, kind: 'camera' },
        { name: 'host_rec_resumed.wav', offsetMs: 5000, kind: 'wav' },
      ],
      echoCancelled: { host: true },
    });
    expect(json.echoCancellation?.files).toEqual(['host_rec_resumed.mp4', 'host_rec_resumed.wav']);
    expect(details['host_rec_resumed.mp4']).toBe('continues from 5.000 s, echo cancellation on');
    expect(details['host_rec.mp4']).toBe('the part before the reload');
  });
});

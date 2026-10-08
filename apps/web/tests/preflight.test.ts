import { describe, it, expect, vi } from 'vitest';
import {
  diskCheck, folderCheck, micCheck, codecCheck, connectionCheck, overallLevel, probeIce, wavCheck,
  journalSpaceCheck, journalSpaceNeed, JOURNAL_FLOOR_MINUTES,
} from '@/lib/preflight';
import { bytesPerHour, presetById, recordingFolderBytesPerHour, QUALITY_PRESETS } from '@/lib/quality';
import { MAX_RECORDED_PEERS } from '@openmeet/protocol';
import { MIC_CLIP_PEAK } from '@/lib/mic-watch';

const p1080 = presetById('1080p');
const GB = 1e9;
// Derived, not hardcoded: the bands are in HOURS, so a bitrate change would
// otherwise silently move which band a fixed byte count lands in. Browser
// storage holds this device's own backup: camera MP4 plus a stereo WAV — and,
// for a host, the take's crash journal.
const perHour = bytesPerHour(p1080, 2);

describe('diskCheck', () => {
  // A disk that fills mid-session is unrecoverable — the file is truncated and
  // there is no second copy on the host side.
  it('fails under an hour of headroom', () => {
    expect(diskCheck(0.9 * perHour, 0, p1080).level).toBe('fail');
  });
  it('warns in the 1-3 hour band', () => {
    expect(diskCheck(2 * perHour, 0, p1080).level).toBe('warn');
  });
  it('passes with plenty of room', () => {
    expect(diskCheck(10 * perHour, 0, p1080).level).toBe('ok');
  });
  it('counts space already in use', () => {
    expect(diskCheck(500 * GB, 500 * GB - 0.5 * perHour, p1080).level).toBe('fail');
  });
  it('warns rather than failing when the quota is unknown', () => {
    expect(diskCheck(undefined, undefined, p1080).level).toBe('warn');
  });
  // Browser storage (OPFS) holds this device's own backup (the host's take
  // also keeps the guests' journal there); the host's copies of everyone's
  // tracks go to the recording folder. Budgeting it for a full room raised a
  // false warning on every normal machine.
  it('budgets for this device’s own backup, not a full room', () => {
    const onePersonFor90Min = bytesPerHour(p1080, 2) * 1.5;
    expect(diskCheck(onePersonFor90Min, 0, p1080).level).toBe('warn');
    expect(diskCheck(onePersonFor90Min, 0, p1080).message).not.toMatch(/Recording folder/);
  });
  // The figure is the browser's storage quota, not the free space on the disk
  // the recordings are saved to. Calling it "free disk space" was untrue.
  it('names the figure as browser storage, not free disk space', () => {
    for (const c of [
      diskCheck(0.5 * perHour, 0, p1080),
      diskCheck(2 * perHour, 0, p1080),
      diskCheck(10 * perHour, 0, p1080),
    ]) {
      expect(c.message).toMatch(/browser storage available/);
      expect(c.message).not.toMatch(/GB free/);
    }
    expect(diskCheck(undefined, undefined, p1080).message).not.toMatch(/free disk space/i);
  });

  it('states browser storage is for backups', () => {
    const c = diskCheck(10 * perHour, 0, p1080);
    expect(c.message).toMatch(/browser storage available \(for backups\)/);
  });

  // The host is the only one whose storage holds the take's journal, so the
  // sentence is the only warning that this take has no crash copy.
  const NO_PROTECTION =
    ' Not enough browser storage to protect this take against a crash — it records to your folder without that copy.';

  it('adds the no-crash-copy sentence for a host under the floor', () => {
    const plain = diskCheck(0.5 * perHour, 0, p1080);
    const host = diskCheck(0.5 * perHour, 0, p1080, true);
    expect(plain.level).toBe('fail');
    expect(host.level).toBe('fail');
    expect(host.message).toBe(plain.message + NO_PROTECTION);
  });

  it('follows the journal floor, not the storage level', () => {
    const floor = (4 * perHour * JOURNAL_FLOOR_MINUTES) / 60;
    const justUnder = diskCheck(floor - 1, 0, p1080, true);
    expect(justUnder.level).toBe('fail');
    expect(justUnder.message).toMatch(/without that copy/);
    const atFloor = diskCheck(floor, 0, p1080, true);
    expect(atFloor.level).toBe('fail');
    expect(atFloor.message).not.toMatch(/without that copy/);
    expect(diskCheck(1.5 * perHour, 0, p1080, true)).toEqual(diskCheck(1.5 * perHour, 0, p1080));
    expect(diskCheck(3.5 * perHour, 0, p1080, true)).toEqual(diskCheck(3.5 * perHour, 0, p1080));
  });

  it('leaves a guest’s message without the no-crash-copy sentence', () => {
    expect(diskCheck(0.5 * perHour, 0, p1080).message).not.toMatch(/without that copy/);
  });

  it('says nothing about a crash copy when the quota is unknown', () => {
    const host = diskCheck(undefined, undefined, p1080, true);
    expect(host.message).toBe(diskCheck(undefined, undefined, p1080).message);
    expect(host.message).not.toMatch(/without that copy/);
  });

});

describe('journalSpaceCheck', () => {
  // The room is the host plus MAX_RECORDED_PEERS - 1 guests, so the journal
  // budgets a whole hour for each of those guests.
  it('budgets a whole hour for every guest the room can hold', () => {
    expect(journalSpaceNeed(p1080, 1)).toBe(perHour);
    expect(journalSpaceNeed(p1080, 3)).toBe(3 * perHour);
    expect(journalSpaceNeed(p1080)).toBe(3 * perHour);
    expect(journalSpaceNeed(p1080, -1)).toBe(0);
  });

  it('asks for ten minutes of the room plus ten minutes of this device', () => {
    const floor = (4 * perHour * JOURNAL_FLOOR_MINUTES) / 60;
    expect(journalSpaceCheck(floor, 0, p1080)).toBe(true);
    expect(journalSpaceCheck(floor - 1, 0, p1080)).toBe(false);
  });

  // An ordinary Chrome profile reports a fixed 10 GiB of free quota; a longer
  // floor would switch the crash copy off for everyone at every preset.
  it('keeps the crash copy on the free quota an ordinary Chrome profile reports', () => {
    for (const preset of QUALITY_PRESETS) {
      expect(journalSpaceCheck(10 * 1024 ** 3, 0, preset)).toBe(true);
    }
  });

  it('counts the space already in use', () => {
    const floor = (4 * perHour * JOURNAL_FLOOR_MINUTES) / 60;
    expect(journalSpaceCheck(floor + 1, 1, p1080)).toBe(true);
    expect(journalSpaceCheck(floor, 1, p1080)).toBe(false);
    // A browser may report the quota with nothing said about what is in use.
    expect(journalSpaceCheck(floor, undefined, p1080)).toBe(true);
  });

  it('promises nothing when the browser cannot report a usable quota', () => {
    expect(journalSpaceCheck(undefined, 0, p1080)).toBe(false);
    expect(journalSpaceCheck(Infinity, 0, p1080)).toBe(false);
  });
});

describe('folderCheck', () => {
  it('states recording-folder space per hour for a full room', () => {
    const c = folderCheck(p1080);
    const gb = (recordingFolderBytesPerHour(p1080, MAX_RECORDED_PEERS) / 1e9).toFixed(1);
    expect(gb).toBe('13.4');
    expect(c.message).toBe(
      `Recording folder: about ${gb} GB per hour for ${MAX_RECORDED_PEERS} people (more with screen sharing).`
    );
  });
  // The browser cannot see free space on the folder's drive, so this informs
  // rather than judging — it must never make the checklist amber.
  it('is informational, never a warning', () => {
    expect(folderCheck(presetById('4k')).level).toBe('ok');
  });
});

describe('micCheck', () => {
  it('holds judgement until enough audio has been sampled', () => {
    expect(micCheck(0, 200).level).toBe('warn');
  });
  it('fails on silence — the OS-muted case', () => {
    expect(micCheck(0.001, 3000).level).toBe('fail');
  });
  it('warns on clipping, which bakes distortion into the master', () => {
    expect(micCheck(0.99, 3000).level).toBe('warn');
  });
  it('does not warn at exactly MIC_CLIP_PEAK', () => {
    expect(micCheck(MIC_CLIP_PEAK, 3000).level).toBe('ok');
  });
  it('passes on normal speech level', () => {
    expect(micCheck(0.3, 3000).level).toBe('ok');
  });
});

describe('codecCheck', () => {
  it('fails when no MP4 encoder exists', () => {
    expect(codecCheck(null).level).toBe('fail');
  });
  it('passes when one was probed', () => {
    expect(codecCheck('video/mp4;codecs=avc1.42E01F,opus').level).toBe('ok');
  });
});

describe('wavCheck', () => {
  it('warns (not fails) when PCM capture is unavailable — MP4 recording still works', () => {
    const c = wavCheck(false);
    expect(c.level).toBe('warn');
    expect(c.message).toMatch(/No uncompressed WAV master/i);
  });
  it('passes when PCM capture is available', () => {
    expect(wavCheck(true).level).toBe('ok');
  });
});

describe('connectionCheck', () => {
  it('is happy once a relay candidate exists', () => {
    expect(connectionCheck(new Set(['host', 'srflx', 'relay'])).level).toBe('ok');
  });
  // Without a relay the call still works on most networks, and nothing a
  // guest can change here would help — so it is neither a failure nor a
  // permanent warning that trains people to ignore amber. What to try if the
  // call won't connect is said then, by the in-call warning.
  it('passes without a relay, in one line and no jargon', () => {
    const c = connectionCheck(new Set(['host', 'srflx']));
    expect(c.level).toBe('ok');
    expect(c.message).toBe('Direct connection available — works on most networks.');
  });
  // A non-breaking space keeps each dash off the start of a wrapped line.
  it('keeps the storage figure’s dash on the line before it', () => {
    expect(diskCheck(10 * perHour, 0, p1080).message).toMatch(/available \(for backups\)\u00a0— roughly/);
  });
  it('warns when even STUN did not answer', () => {
    expect(connectionCheck(new Set(['host'])).level).toBe('warn');
  });
});

describe('probeIce', () => {
  function fakePc(candidates: (string | null)[]) {
    const pc = {
      onicecandidate: null as ((e: { candidate: RTCIceCandidate | null }) => void) | null,
      createDataChannel: vi.fn(),
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: '' })),
      setLocalDescription: vi.fn(async () => {
        setTimeout(() => {
          for (const c of candidates) {
            pc.onicecandidate?.({
              candidate: c === null ? null : ({ type: undefined, candidate: c } as unknown as RTCIceCandidate),
            });
          }
        }, 0);
      }),
      close: vi.fn(),
    };
    return pc;
  }

  it('reads candidate types out of the SDP when the field is absent', async () => {
    const pc = fakePc(['candidate:1 1 udp 1 1.2.3.4 1 typ srflx', 'candidate:2 1 udp 1 5.6.7.8 1 typ relay']);
    const types = await probeIce([], 2000, () => pc as unknown as RTCPeerConnection);
    expect(types.has('srflx')).toBe(true);
    expect(types.has('relay')).toBe(true);
  });

  it('stops early on a relay instead of waiting out the timeout', async () => {
    const pc = fakePc(['candidate:1 1 udp 1 5.6.7.8 1 typ relay']);
    const started = Date.now();
    await probeIce([], 10_000, () => pc as unknown as RTCPeerConnection);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns an empty set rather than throwing when probing fails', async () => {
    const broken = { createDataChannel: () => { throw new Error('nope'); }, close: () => {} };
    await expect(probeIce([], 100, () => broken as unknown as RTCPeerConnection)).resolves.toEqual(new Set());
  });
});

describe('overallLevel', () => {
  it('reports the worst level present', () => {
    expect(overallLevel([{ id: 'a', level: 'ok', message: '' }, { id: 'b', level: 'fail', message: '' }])).toBe('fail');
    expect(overallLevel([{ id: 'a', level: 'ok', message: '' }, { id: 'b', level: 'warn', message: '' }])).toBe('warn');
    expect(overallLevel([{ id: 'a', level: 'ok', message: '' }])).toBe('ok');
  });
});

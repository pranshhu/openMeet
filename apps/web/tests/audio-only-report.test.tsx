import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildSyncReport, type FileCheck } from '@/lib/sync-report';
import { SessionSummary } from '@/components/SessionSummary';
import {
  startHostRecording,
  endHostRecording,
  resumeHostRecording,
  collectFileChecks,
} from '@/hooks/recording-controller';
import type { TakeJournal, TakeNotes } from '@/lib/take-journal';

const base = {
  recordingId: 'r',
  hostFile: 'host_r.mp4',
  hostWavFile: 'host_r.wav',
  hostStartMs: 1000,
  hostTrackFps: 30,
  guests: [
    {
      slot: 0,
      name: 'Bo',
      file: 'guest_r.mp4',
      wavFile: 'guest_r.wav',
      startHostMs: 1500,
      rttMs: 10,
      trackFps: 30,
    },
  ],
};

const checks = (...audioOnly: string[]) =>
  new Map<string, FileCheck>(
    ['host_r.mp4', 'host_r.wav', 'guest_r.mp4', 'guest_r.wav'].map((name) => [
      name,
      { bytes: 10, ...(audioOnly.includes(name) ? { audioOnly: true } : {}) },
    ])
  );

const kindOf = (report: ReturnType<typeof buildSyncReport>, name: string) =>
  report.data.fileList.find((f) => f.name === name)?.kind;
const pairs = (report: ReturnType<typeof buildSyncReport>) =>
  report.data.commands.filter((c) => c.cmd.includes('-map 0:v')).map((c) => c.cmd);

describe('buildSyncReport: a file recorded with no camera', () => {
  it('names a guest file with no picture as audio only and prints no video command for it', () => {
    const report = buildSyncReport({ ...base, checks: checks('guest_r.mp4') });
    const json = JSON.parse(report.json);

    expect(kindOf(report, 'guest_r.mp4')).toBe('audio-only');
    expect(kindOf(report, 'host_r.mp4')).toBe('video');
    expect(json.audioOnly.files).toEqual(['guest_r.mp4']);
    expect(json.audioOnly.note).toContain('no camera');
    expect(json.audioOnly.note).toContain('no pairing command');
    expect(json.audioOnly.note).toContain('WAV master');
    expect(json.combine.guest).toBeUndefined();
    expect(json.combine.host).toContain('host_r.mp4');
    expect(pairs(report).some((cmd) => cmd.includes('guest_r.mp4'))).toBe(false);
    expect(json.frameRate.files.map((f: { file: string }) => f.file)).toEqual(['host_r.mp4']);
    // Still a file of the take: listed, checked, and seekable like any other.
    expect(json.files.guest).toBe('guest_r.mp4');
    expect(json.audioMasters.guest).toBe('guest_r.wav');
    expect(json.seekability.remuxGuest).toContain('guest_r.mp4');
    expect(json.aligned.files.map((f: { file: string }) => f.file)).toContain('guest_r.mp4');
    expect(json.verification.map((v: { file: string }) => v.file)).toContain('guest_r.mp4');
    expect(report.data.warnings).not.toContain('no WAV master for Bo');
  });

  it('does the same for the host file', () => {
    const report = buildSyncReport({ ...base, checks: checks('host_r.mp4') });
    const json = JSON.parse(report.json);

    expect(kindOf(report, 'host_r.mp4')).toBe('audio-only');
    expect(kindOf(report, 'guest_r.mp4')).toBe('video');
    expect(json.audioOnly.files).toEqual(['host_r.mp4']);
    expect(json.combine.host).toBeUndefined();
    expect(json.combine.guest).toContain('guest_r.mp4');
    expect(pairs(report).some((cmd) => cmd.includes('host_r.mp4'))).toBe(false);
    expect(json.frameRate.files.map((f: { file: string }) => f.file)).toEqual(['guest_r.mp4']);
    expect(json.seekability.remuxHost).toContain('host_r.mp4');
    expect(report.data.fileList.find((f) => f.name === 'host_r.mp4')?.verdict?.text).toBe(
      'Complete. Recorded on this computer.'
    );
  });

  it('reads as a camera take when every file has a picture, or when no file has a check', () => {
    for (const input of [{ ...base, checks: checks() }, base]) {
      const report = buildSyncReport(input);
      const json = JSON.parse(report.json);
      expect(kindOf(report, 'host_r.mp4')).toBe('video');
      expect(kindOf(report, 'guest_r.mp4')).toBe('video');
      expect(json.audioOnly).toBeUndefined();
      expect(pairs(report)).toHaveLength(2);
      expect(json.frameRate.files.map((f: { file: string }) => f.file)).toEqual(['host_r.mp4', 'guest_r.mp4']);
    }
  });

  it('keeps the aligned copy and the remux of a host file with no picture', () => {
    const report = buildSyncReport({
      recordingId: 'rec',
      hostFile: 'host_rec.mp4',
      hostWavFile: 'host_rec.wav',
      hostStartMs: 0,
      guests: [],
      checks: new Map([['host_rec.mp4', { bytes: 10, audioOnly: true }]]),
    });
    const json = JSON.parse(report.json);
    expect(JSON.stringify(json.aligned)).toContain('host_rec.mp4');
    expect(json.seekability.remuxHost).toContain('host_rec.mp4');
  });
});

describe('SessionSummary: a file recorded with no camera', () => {
  it('calls it audio only, with its size', () => {
    render(
      <SessionSummary
        files={[{ name: 'guest_r.mp4', kind: 'audio-only', bytes: 1_200_000 }]}
        markers={[]}
        warnings={[]}
        integrity={null}
        alignment={null}
        commands={[]}
        syncReportUrl={null}
        chaptersUrl={null}
        backupUrl={null}
        wavBackupUrl={null}
        downloadNames={{ sync: 's.json', chapters: 'c.txt', backup: 'b.mp4', wav: 'b.wav' }}
        takes={[]}
        onNewTake={vi.fn()}
        onDiscardTake={vi.fn()}
      />
    );
    expect(screen.getByText('Audio only, no camera · 1 MB')).toBeInTheDocument();
    expect(screen.queryByText(/Camera ·/)).toBeNull();
  });
});

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  state = 'inactive';
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

const mic = { kind: 'audio', enabled: true, getSettings: () => ({ sampleRate: 48000, channelCount: 1 }) };
const cam = { kind: 'video', enabled: true, getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }) };
const micOnly = () =>
  Object.assign(new EventTarget(), {
    getTracks: () => [mic],
    getAudioTracks: () => [mic],
    getVideoTracks: () => [],
  }) as unknown as MediaStream;
const withCamera = () =>
  Object.assign(new EventTarget(), {
    getTracks: () => [mic, cam],
    getAudioTracks: () => [mic],
    getVideoTracks: () => [cam],
  }) as unknown as MediaStream;
const noMedia = () =>
  Object.assign(new EventTarget(), {
    getTracks: () => [],
    getAudioTracks: () => [],
    getVideoTracks: () => [],
  }) as unknown as MediaStream;

const folder = () => ({
  getFileHandle: async (name: string) => ({
    name,
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
  }),
});

describe('the host’s own file', () => {
  beforeEach(() => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  });
  afterEach(() => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  });

  it('is checked as audio only when the host recorded with a microphone and no camera', async () => {
    const handles = await startHostRecording({
      recordingId: 'r1',
      localStream: micOnly(),
      dir: folder() as never,
      journal: false,
    });
    try {
      expect(handles.audioOnly).toBe(true);
      const found = await collectFileChecks(handles);
      expect(found.get('host_r1.mp4')?.audioOnly).toBe(true);
      // The first guest's file is not the host's: nothing is claimed for it here.
      expect(found.get('guest_r1.mp4')?.audioOnly).toBeUndefined();
    } finally {
      await endHostRecording(handles);
    }
  });

  it('is a camera file when the host has a camera', async () => {
    const handles = await startHostRecording({
      recordingId: 'r2',
      localStream: withCamera(),
      dir: folder() as never,
      journal: false,
    });
    try {
      expect(handles.audioOnly).toBeUndefined();
      expect((await collectFileChecks(handles)).get('host_r2.mp4')?.audioOnly).toBeUndefined();
    } finally {
      await endHostRecording(handles);
    }
  });

  it('is not checked as audio only when the host joined with no stream at all', async () => {
    const handles = await startHostRecording({
      recordingId: 'r3',
      localStream: noMedia(),
      dir: folder() as never,
      journal: false,
    });
    try {
      expect(handles.audioOnly).toBeUndefined();
      expect((await collectFileChecks(handles)).get('host_r3.mp4')).toBeUndefined();
    } finally {
      await endHostRecording(handles);
    }
  });

  it('is checked as audio only for the part recorded after a reload', async () => {
    const notes: TakeNotes = {
      room: 'abc-defg-hij',
      recordingId: 'rec',
      take: 1,
      hostStartMs: Date.now() - 90_000,
      files: [],
      backups: [],
      markers: [],
    };
    const journal = {
      dirName: 'openmeet-take-1-abc-defg-hij',
      notes,
      finish: vi.fn().mockResolvedValue(undefined),
      note: (change: (n: TakeNotes) => void) => change(notes),
      file: () => ({ append: () => {}, commit: async () => {}, dead: false }),
    } as unknown as TakeJournal;

    const handles = await resumeHostRecording({
      journal,
      dir: folder() as never,
      localStream: micOnly(),
      channels: [],
    });
    try {
      expect(handles.audioOnly).toBe(true);
      expect((await collectFileChecks(handles)).get('host_rec_resumed.mp4')?.audioOnly).toBe(true);
    } finally {
      await endHostRecording(handles);
    }
  });

  it('is a camera file when the host’s camera is only turned off', async () => {
    const off = { ...cam, enabled: false };
    const cameraOff = Object.assign(new EventTarget(), {
      getTracks: () => [mic, off],
      getAudioTracks: () => [mic],
      getVideoTracks: () => [off],
    }) as unknown as MediaStream;
    const handles = await startHostRecording({
      recordingId: 'r4',
      localStream: cameraOff,
      dir: folder() as never,
      journal: false,
    });
    try {
      expect(handles.audioOnly).toBeUndefined();
      expect((await collectFileChecks(handles)).get('host_r4.mp4')?.audioOnly).toBeUndefined();
    } finally {
      await endHostRecording(handles);
    }
  });

  it('is a camera file for the part recorded after a reload when the host has a camera', async () => {
    const notes: TakeNotes = {
      room: 'abc-defg-hij',
      recordingId: 'rec',
      take: 1,
      hostStartMs: Date.now() - 90_000,
      files: [],
      backups: [],
      markers: [],
    };
    const journal = {
      dirName: 'openmeet-take-1-abc-defg-hij',
      notes,
      finish: vi.fn().mockResolvedValue(undefined),
      note: (change: (n: TakeNotes) => void) => change(notes),
      file: () => ({ append: () => {}, commit: async () => {}, dead: false }),
    } as unknown as TakeJournal;

    const handles = await resumeHostRecording({
      journal,
      dir: folder() as never,
      localStream: withCamera(),
      channels: [],
    });
    try {
      expect(handles.audioOnly).toBeUndefined();
      expect((await collectFileChecks(handles)).get('host_rec_resumed.mp4')?.audioOnly).toBeUndefined();
    } finally {
      await endHostRecording(handles);
    }
  });
});

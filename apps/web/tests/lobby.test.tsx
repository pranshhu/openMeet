import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { Lobby } from '@/components/Lobby';
import { PreflightPanel } from '@/components/PreflightPanel';
import { diskCheck, folderCheck } from '@/lib/preflight';
import {
  DEFAULT_BITRATE_ID,
  atBitrate,
  cameraVideoBps,
  chooseBitrate,
  formatPerHour,
  presetAt,
  presetById,
} from '@/lib/quality';
import { formatBytes } from '@/lib/sync-report';
import type { TakeJournal } from '@/lib/take-journal';
import type { FsDirectoryHandle } from '@/lib/fs-writer';

const JOURNAL_A = 'openmeet-take-1759824000000-xyz-abcd-pqr';
const JOURNAL_B = 'openmeet-take-1759800000000-klm-nopq-rst';
const JOURNAL_C = 'openmeet-take-1759752000000-klm-nopq-rst';

function fakeStream(): MediaStream {
  const tracks = [{ kind: 'audio', enabled: true, stop: vi.fn() }, { kind: 'video', enabled: true, stop: vi.fn() }];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}

/** A real-looking 720p webcam: settings AND capabilities, so presets get filtered. */
function cam720Stream(
  frameRate = 30,
  sampleRate = 48000,
  channelCount?: number,
  maxFrameRate?: number
): MediaStream {
  const audio = {
    kind: 'audio',
    enabled: true,
    stop: vi.fn(),
    getSettings: () => (channelCount === undefined ? { sampleRate } : { sampleRate, channelCount }),
  };
  const video = {
    kind: 'video',
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ width: 1280, height: 720, frameRate }),
    getCapabilities: () => ({
      width: { max: 1280 },
      height: { max: 720 },
      ...(maxFrameRate === undefined ? {} : { frameRate: { max: maxFrameRate } }),
    }),
  };
  return {
    getTracks: () => [audio, video],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  } as unknown as MediaStream;
}

const DEVICES = [
  { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
  { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
];

describe('Lobby', () => {
  beforeEach(() => {
    class FakeMediaStream {
      tracks: unknown[];
      constructor(tracks: unknown[] = []) {
        this.tracks = tracks;
      }
      getTracks() { return this.tracks; }
      getAudioTracks() { return (this.tracks as { kind: string }[]).filter((t) => t.kind === 'audio'); }
      getVideoTracks() { return (this.tracks as { kind: string }[]).filter((t) => t.kind === 'video'); }
    }
    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
  });

  // A pick writes om_bitrate and Join sets the tab's level; neither may reach
  // the next test.
  afterEach(() => {
    localStorage.removeItem('om_bitrate');
    chooseBitrate(DEFAULT_BITRATE_ID);
  });

  // The pickers render only when devices are listed.
  const stubDevices = (stream: MediaStream, extra: Record<string, unknown> = {}) =>
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        enumerateDevices: vi.fn().mockResolvedValue(DEVICES),
      },
      ...extra,
    });
  // What a 1080p camera would be recorded at in this tab.
  const recorderBps = () =>
    cameraVideoBps({ getSettings: () => ({ height: 1080 }) } as unknown as MediaStreamTrack);

  it('offers Standard, High and Maximum bitrate and remembers the pick', async () => {
    stubDevices(fakeStream());
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const select = (await screen.findByLabelText('Recording bitrate')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Bitrate: Standard · up to 5 Mbps',
      'Bitrate: High · up to 7.5 Mbps',
      'Bitrate: Maximum · up to 10 Mbps',
    ]);
    expect(select).toHaveValue('standard');
    fireEvent.change(select, { target: { value: 'high' } });
    expect(select).toHaveValue('high');
    expect(localStorage.getItem('om_bitrate')).toBe('high');
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('sizes the storage and folder figures for the remembered bitrate', async () => {
    localStorage.setItem('om_bitrate', 'max');
    localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
    try {
      stubDevices(fakeStream(), {
        storage: { estimate: vi.fn().mockResolvedValue({ quota: 100e9, usage: 0 }) },
      });
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const atMax = atBitrate(presetById('1080p'), 'max');
      // The DOM query collapses the message's non-breaking space.
      const text = (m: string) => m.replace(/\s+/g, ' ');
      await waitFor(() =>
        expect(screen.getByText(text(diskCheck(100e9, 0, atMax).message))).toBeInTheDocument()
      );
      expect(screen.getByText(text(folderCheck(atMax).message))).toBeInTheDocument();
      const select = screen.getByLabelText('Recording bitrate');
      expect(select).toHaveValue('max');
      expect(
        screen.getByRole('option', { name: `Quality: 1080p · ${formatPerHour(atMax, 1)} per person` })
      ).toBeInTheDocument();
      fireEvent.change(select, { target: { value: 'standard' } });
      await waitFor(() =>
        expect(
          screen.getByText(text(diskCheck(100e9, 0, presetById('1080p')).message))
        ).toBeInTheDocument()
      );
    } finally {
      localStorage.removeItem('om_host_xyz-abcd-pqr');
    }
  });

  it('joins at the bitrate picked, even when storage refuses the write', async () => {
    stubDevices(fakeStream());
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const onJoin = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
      const select = await screen.findByLabelText('Recording bitrate');
      fireEvent.change(select, { target: { value: 'high' } });
      expect(select).toHaveValue('high');
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
      fireEvent.click(screen.getByRole('button', { name: 'Join now' }));
      await waitFor(() => expect(onJoin).toHaveBeenCalled());
      expect(recorderBps()).toBe(7_500_000);
    } finally {
      setItem.mockRestore();
    }
  });

  it('shows Standard when the remembered level is not offered at 4K, and joins at Standard', async () => {
    const audio = { kind: 'audio', enabled: true, stop: vi.fn(), getSettings: () => ({ sampleRate: 48000 }) };
    const video = {
      kind: 'video',
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ width: 3840, height: 2160, frameRate: 30 }),
      getCapabilities: () => ({ width: { max: 3840 }, height: { max: 2160 } }),
    };
    const cam4k = {
      getTracks: () => [audio, video],
      getAudioTracks: () => [audio],
      getVideoTracks: () => [video],
    } as unknown as MediaStream;
    localStorage.setItem('om_quality', '4k');
    localStorage.setItem('om_bitrate', 'max');
    try {
      stubDevices(cam4k);
      const onJoin = vi.fn();
      render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
      await waitFor(() => expect(screen.getByLabelText('Recording quality')).toHaveValue('4k'));
      const select = screen.getByLabelText('Recording bitrate') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
        'Bitrate: Standard · up to 25 Mbps',
      ]);
      // Each quality is priced at the remembered level, not at the Standard one.
      expect(
        screen.getByRole('option', {
          name: `Quality: 1080p · ${formatPerHour(atBitrate(presetById('1080p'), 'max'), 1)} per person`,
        })
      ).toBeInTheDocument();
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
      fireEvent.click(screen.getByRole('button', { name: 'Join now' }));
      await waitFor(() => expect(onJoin).toHaveBeenCalled());
      expect(recorderBps()).toBe(5_000_000);
    } finally {
      localStorage.removeItem('om_quality');
    }
  });

  // Like the disk estimate, the options are for the resolution this camera can
  // deliver: a remembered 4K must not price them at 4K.
  it('sizes the bitrate options for the resolution the camera can deliver', async () => {
    localStorage.setItem('om_quality', '4k');
    localStorage.setItem('om_bitrate', 'max');
    try {
      stubDevices(cam720Stream());
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await waitFor(() => expect(screen.getByLabelText('Recording quality')).toHaveValue('720p'));
      const select = screen.getByLabelText('Recording bitrate') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
        'Bitrate: Standard · up to 2.5 Mbps',
        'Bitrate: High · up to 3.75 Mbps',
        'Bitrate: Maximum · up to 5 Mbps',
      ]);
      expect(select).toHaveValue('max');
    } finally {
      localStorage.removeItem('om_quality');
    }
  });

  it('requires a name: Join enabled only after media grant AND a name', async () => {
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /join/i })).not.toBeDisabled());
    // Blank/whitespace name disables Join again.
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: /join/i })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: /join/i }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith(expect.anything(), 'Alice', false, undefined, false));
  });

  // On a phone the page is one column in DOM order. With the device pickers
  // and preflight checklist first, Join now landed below the fold at 390x844.
  it('puts Join now before the device checks, so a phone reaches it without scrolling', async () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const checklist = await screen.findByText(/Wear headphones/);
    const join = screen.getByRole('button', { name: /join now/i });
    expect(join.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Under the checklist they started below the fold even on a laptop, and a
  // guest back after a crash may hold the only copy of their part.
  it('lists backups in the join panel, before the device checks', async () => {
    const fakeFile = new File(['content'], 'openmeet-backup.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([fakeFile]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const backups = await screen.findByRole('heading', { name: 'Backups on this device' });
      const checklist = await screen.findByText(/Wear headphones/);
      const invite = screen.getByRole('button', { name: /copy invite link/i });
      expect(invite.compareDocumentPosition(backups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(backups.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      findBackupsSpy.mockRestore();
    }
  });

  it('shows a permission error when getUserMedia is denied', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('no'), { name: 'NotAllowedError' })
    );
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/permission/i)).toBeInTheDocument());
    expect(screen.queryByText(/Capturing/)).not.toBeInTheDocument();
  });

  it('renders recording backup, allows download and delete, and revokes URL on unmount', async () => {
    const fakeFile = new File(['content'], 'openmeet-backup.mp4', {
      lastModified: 1700000000000,
    });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups')
      .mockResolvedValue([fakeFile]);
    const deleteBackupSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'deleteBackup')
      .mockResolvedValue(undefined);

    const createObjectURL = vi.fn().mockReturnValue('blob:http://localhost/test-backup');
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

    // Row should be displayed
    const expectedTime = new Date(fakeFile.lastModified).toLocaleString();
    await waitFor(() => {
      expect(screen.getByText(new RegExp(`Recording backup \\(MP4\\) from ${expectedTime}`))).toBeInTheDocument();
    });

    // Download link should have correct href and download attribute
    const downloadLink = screen.getByRole('link', { name: /download/i });
    expect(downloadLink).toHaveAttribute('href', 'blob:http://localhost/test-backup');
    expect(downloadLink).toHaveAttribute('download', 'openmeet-backup.mp4');

    // Delete button removes the row and calls deleteBackup
    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(deleteBackupSpy).toHaveBeenCalledWith('openmeet-backup.mp4');
      expect(screen.queryByText(new RegExp(`Recording backup \\(MP4\\) from ${expectedTime}`))).not.toBeInTheDocument();
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/test-backup');

    unmount();

    findBackupsSpy.mockRestore();
    deleteBackupSpy.mockRestore();
    confirm.mockRestore();
  });

  it('shows a backup’s size the way the in-call notices do', async () => {
    const bytes = 754_146;
    const fakeFile = new File([new Uint8Array(bytes)], 'openmeet-backup.mp4', {
      lastModified: 1700000000000,
    });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups')
      .mockResolvedValue([fakeFile]);

    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Recording backup \(MP4\) from/)).toBeInTheDocument();
    });

    expect(screen.getByText(`· ${formatBytes(bytes)}`)).toBeInTheDocument();
    expect(screen.queryByText('· 1 MB')).not.toBeInTheDocument();

    findBackupsSpy.mockRestore();
  });

  it('lists screen backups as a screen backup with download and delete controls', async () => {
    const fakeFile = new File(['content'], 'openmeet-backup-screen-1700000000000-xyz-abcd-pqr.mp4', {
      lastModified: 1700000000000,
    });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups')
      .mockResolvedValue([fakeFile]);
    const deleteBackupSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'deleteBackup')
      .mockResolvedValue(undefined);

    const createObjectURL = vi.fn().mockReturnValue('blob:http://localhost/test-screen-backup');
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

    const expectedTime = new Date(fakeFile.lastModified).toLocaleString();
    await waitFor(() => {
      expect(screen.getByText(new RegExp(`Screen backup from ${expectedTime} in room xyz-abcd-pqr`))).toBeInTheDocument();
    });

    const downloadLink = screen.getByRole('link', { name: /download screen backup/i });
    expect(downloadLink).toHaveAttribute('href', 'blob:http://localhost/test-screen-backup');
    expect(downloadLink).toHaveAttribute('download', 'openmeet-backup-screen-1700000000000-xyz-abcd-pqr.mp4');

    const deleteBtn = screen.getByRole('button', { name: /delete screen backup/i });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(deleteBackupSpy).toHaveBeenCalledWith('openmeet-backup-screen-1700000000000-xyz-abcd-pqr.mp4');
      expect(screen.queryByText(new RegExp(`Screen backup from ${expectedTime}`))).not.toBeInTheDocument();
    });

    unmount();
    findBackupsSpy.mockRestore();
    deleteBackupSpy.mockRestore();
    confirm.mockRestore();
  });

  it('asks before deleting a backup, and keeps it when the user says no', async () => {
    const fakeFile = new File(['content'], 'openmeet-backup.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([fakeFile]);
    const deleteBackupSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'deleteBackup').mockResolvedValue(undefined);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const when = new Date(fakeFile.lastModified).toLocaleString();
      const title = await screen.findByText(`Recording backup (MP4) from ${when}`);
      // Under a heading that says what these are.
      expect(screen.getByRole('heading', { name: 'Backups on this device' })).toBeInTheDocument();
      expect(title.parentElement?.textContent).toMatch(new RegExp(`· ${formatBytes(fakeFile.size)}$`));

      fireEvent.click(screen.getByRole('button', { name: /delete/i }));
      expect(confirm).toHaveBeenCalled();
      await Promise.resolve();
      expect(deleteBackupSpy).not.toHaveBeenCalled();
      expect(screen.getByText(`Recording backup (MP4) from ${when}`)).toBeInTheDocument();
    } finally {
      findBackupsSpy.mockRestore();
      deleteBackupSpy.mockRestore();
      confirm.mockRestore();
    }
  });

  it('revokes backup object URLs on unmount when not deleted', async () => {
    const fakeFile = new File(['content'], 'openmeet-backup.mp4', {
      lastModified: 1700000000000,
    });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups')
      .mockResolvedValue([fakeFile]);
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = vi.fn().mockReturnValue('blob:http://localhost/test-backup-unmount');
    URL.revokeObjectURL = revokeObjectURL;

    const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument();
    });

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/test-backup-unmount');

    findBackupsSpy.mockRestore();
  });

  /** A journal as findTakeJournals hands it back: the lobby reads only these fields. */
  function fakeJournal(
    dirName: string,
    notes: { room: string; hostStartMs: number },
    bytes: number,
    notesOk = true
  ): TakeJournal {
    return { dirName, notes, notesOk, bytes } as unknown as TakeJournal;
  }

  /** A lobby holding one unsaved recording of this room, with the journal listing mocked. */
  async function renderUnsaved() {
    const hostStartMs = 1759824000000;
    const when = new Date(hostStartMs).toLocaleString();
    const journal = fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs }, 2_500_000_000);
    const findJournalsSpy = vi
      .spyOn(await import('@/lib/take-journal'), 'findTakeJournals')
      .mockResolvedValue([journal]);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByText(`Recording from ${when}`);
    return { journal, when, findJournalsSpy };
  }

  const saveButton = (when: string) =>
    screen.getByRole('button', { name: `Save the unsaved recording from ${when} to a folder` });

  it('lists this room’s unfinished recording and hides another room’s', async () => {
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([
      fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs: 1759824000000 }, 2_500_000_000),
      fakeJournal(JOURNAL_B, { room: 'klm-nopq-rst', hostStartMs: 1759800000000 }, 1_000_000),
      // Readable, but it names this room from another room's directory.
      fakeJournal(JOURNAL_C, { room: 'xyz-abcd-pqr', hostStartMs: 1759752000000 }, 1_000_000),
    ]);
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const when = new Date(1759824000000).toLocaleString();
      const row = await screen.findByText(`Recording from ${when}`);
      expect(screen.getAllByRole('heading', { name: 'Unsaved recording' })).toHaveLength(1);
      expect(
        screen.getByText('A recording made in this browser was interrupted before it was saved to a folder.')
      ).toBeInTheDocument();
      expect(row.parentElement?.textContent).toMatch(/· 2\.5 GB$/);
      expect(screen.queryByText(`Recording from ${new Date(1759800000000).toLocaleString()}`)).not.toBeInTheDocument();
      expect(screen.queryByText(`Recording from ${new Date(1759752000000).toLocaleString()}`)).not.toBeInTheDocument();
    } finally {
      findJournalsSpy.mockRestore();
    }
  });

  it('puts the unsaved recording under the backups list and before the device checks', async () => {
    const fakeFile = new File(['content'], 'openmeet-backup.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([fakeFile]);
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([
      fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs: 1759824000000 }, 2_500_000_000),
    ]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const backups = await screen.findByRole('heading', { name: 'Backups on this device' });
      const unsaved = await screen.findByRole('heading', { name: 'Unsaved recording' });
      const checklist = await screen.findByText(/Wear headphones/);
      const invite = screen.getByRole('button', { name: /copy invite link/i });
      expect(invite.compareDocumentPosition(unsaved) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(backups.compareDocumentPosition(unsaved) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(unsaved.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      findBackupsSpy.mockRestore();
      findJournalsSpy.mockRestore();
    }
  });

  it('shows no unsaved recording when this browser holds none', async () => {
    const { request } = takeHeldElsewhere();
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([]);
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await waitFor(() => expect(findJournalsSpy).toHaveBeenCalled());
      await settle();
      expect(screen.queryByRole('heading', { name: 'Unsaved recording' })).not.toBeInTheDocument();
      // Nothing to hide, so the room's lock is never asked for.
      expect(request).not.toHaveBeenCalled();
    } finally {
      findJournalsSpy.mockRestore();
    }
  });

  it('lists every unfinished recording of this room', async () => {
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([
      fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs: 1759824000000 }, 2_500_000_000),
      fakeJournal('openmeet-take-1759812000000-xyz-abcd-pqr', { room: 'xyz-abcd-pqr', hostStartMs: 1759812000000 }, 1_000_000),
    ]);
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const first = await screen.findByText(`Recording from ${new Date(1759824000000).toLocaleString()}`);
      const second = screen.getByText(`Recording from ${new Date(1759812000000).toLocaleString()}`);
      expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getAllByRole('button', { name: /delete unsaved recording/i })).toHaveLength(2);
    } finally {
      findJournalsSpy.mockRestore();
    }
  });

  it('does not open another room’s journal when the slug is only its tail', async () => {
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([
      fakeJournal(JOURNAL_B, { room: 'klm-nopq-rst', hostStartMs: 1759800000000 }, 1_000_000),
    ]);
    try {
      render(<Lobby slug="nopq-rst" onJoin={vi.fn()} />);
      await waitFor(() => expect(findJournalsSpy).toHaveBeenCalled());
      await settle();
      expect(screen.queryByRole('heading', { name: 'Unsaved recording' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /delete unsaved recording/i })).not.toBeInTheDocument();
    } finally {
      findJournalsSpy.mockRestore();
    }
  });

  it('re-reads the journals when the room changes', async () => {
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([
      fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs: 1759824000000 }, 2_500_000_000),
    ]);
    try {
      const { rerender } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await screen.findByRole('heading', { name: 'Unsaved recording' });
      findJournalsSpy.mockResolvedValue([]);
      rerender(<Lobby slug="klm-nopq-rst" onJoin={vi.fn()} />);
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Unsaved recording' })).not.toBeInTheDocument()
      );
    } finally {
      findJournalsSpy.mockRestore();
    }
  });

  it('ignores a slow journal response from a previous room', async () => {
    let resolveFirst!: (value: TakeJournal[]) => void;
    const slowFirst = new Promise<TakeJournal[]>((res) => {
      resolveFirst = res;
    });
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals')
      .mockReturnValueOnce(slowFirst)
      .mockResolvedValueOnce([]);

    try {
      const { rerender } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      rerender(<Lobby slug="klm-nopq-rst" onJoin={vi.fn()} />);
      await settle();

      await act(async () => {
        resolveFirst([
          fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs: 1759824000000 }, 2_500_000_000),
        ]);
      });
      await settle();

      expect(screen.queryByRole('heading', { name: 'Unsaved recording' })).not.toBeInTheDocument();
    } finally {
      findJournalsSpy.mockRestore();
    }
  });

  it('hides the unsaved recording while another tab records this room', async () => {
    const { request } = takeHeldElsewhere();
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([
      fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs: 1759824000000 }, 2_500_000_000),
      fakeJournal('openmeet-take-1759812000000-xyz-abcd-pqr', { room: 'xyz-abcd-pqr', hostStartMs: 1759812000000 }, 1_000_000),
    ]);
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await waitFor(() => expect(findJournalsSpy).toHaveBeenCalled());
      await settle();
      expect(screen.queryByRole('heading', { name: 'Unsaved recording' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /delete unsaved recording/i })).not.toBeInTheDocument();
      // One lock for the room, not one per row.
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]![0]).toBe('openmeet-take:xyz-abcd-pqr');
    } finally {
      findJournalsSpy.mockRestore();
    }
  });

  it('asks before deleting an unsaved recording, and keeps it when the user says no', async () => {
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([
      fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs: 1759824000000 }, 2_500_000_000),
    ]);
    const deleteJournalSpy = vi.spyOn(await import('@/lib/take-journal'), 'deleteTakeJournal').mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const when = new Date(1759824000000).toLocaleString();
      await screen.findByText(`Recording from ${when}`);
      fireEvent.click(screen.getByRole('button', { name: /delete unsaved recording/i }));
      expect(confirm).toHaveBeenCalledWith('Delete this unsaved recording? It can’t be recovered.');
      await settle();
      expect(deleteJournalSpy).not.toHaveBeenCalled();
      expect(screen.getByText(`Recording from ${when}`)).toBeInTheDocument();
    } finally {
      findJournalsSpy.mockRestore();
      deleteJournalSpy.mockRestore();
      confirm.mockRestore();
    }
  });

  it('deletes the unsaved recording when the user confirms', async () => {
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([
      fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs: 1759824000000 }, 2_500_000_000),
    ]);
    const deleteJournalSpy = vi.spyOn(await import('@/lib/take-journal'), 'deleteTakeJournal').mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const when = new Date(1759824000000).toLocaleString();
      await screen.findByText(`Recording from ${when}`);
      fireEvent.click(screen.getByRole('button', { name: `Delete unsaved recording from ${when}` }));
      await waitFor(() => {
        expect(deleteJournalSpy).toHaveBeenCalledWith(JOURNAL_A);
        expect(screen.queryByText(`Recording from ${when}`)).not.toBeInTheDocument();
      });
    } finally {
      findJournalsSpy.mockRestore();
      deleteJournalSpy.mockRestore();
      confirm.mockRestore();
    }
  });

  it('asks for a folder once and reports the files it saved', async () => {
    // Removal that must fail this test: the save handler, or the setJournals filter.
    const { journal, when, findJournalsSpy } = await renderUnsaved();
    const folder = { getFileHandle: vi.fn() } as unknown as FsDirectoryHandle;
    const pickSpy = vi
      .spyOn(await import('@/lib/fs-writer'), 'pickRecordingDirectory')
      .mockResolvedValue(folder);
    const saveSpy = vi.spyOn(await import('@/lib/take-recovery'), 'saveRecoveredTake').mockResolvedValue({
      files: [{ name: 'guest_r.mp4', bytes: 1024, source: 'journal' }],
      json: 'sync_rec-1.json',
      chapters: false,
    });
    try {
      fireEvent.click(saveButton(when));
      const line = await screen.findByText('Saved 1 file to your folder.');

      expect(line).toHaveAttribute('role', 'status');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(pickSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledWith(journal, folder);
      expect(screen.queryByText(`Recording from ${when}`)).not.toBeInTheDocument();
    } finally {
      pickSpy.mockRestore();
      saveSpy.mockRestore();
      findJournalsSpy.mockRestore();
    }
  });

  it('changes nothing when the folder prompt is cancelled', async () => {
    // Removal that must fail this test: the if (!folder) return.
    const { when, findJournalsSpy } = await renderUnsaved();
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const pickSpy = vi
      .spyOn(await import('@/lib/fs-writer'), 'pickRecordingDirectory')
      .mockRejectedValue(abort);
    const saveSpy = vi.spyOn(await import('@/lib/take-recovery'), 'saveRecoveredTake').mockResolvedValue({
      files: [],
      json: 'sync_rec-1.json',
      chapters: false,
    });
    try {
      fireEvent.click(saveButton(when));
      await waitFor(() => expect(pickSpy).toHaveBeenCalledTimes(1));
      await settle();

      expect(saveSpy).not.toHaveBeenCalled();
      expect(screen.getByText(`Recording from ${when}`)).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    } finally {
      pickSpy.mockRestore();
      saveSpy.mockRestore();
      findJournalsSpy.mockRestore();
    }
  });

  it('does not start a second save while one is running', async () => {
    // Removal that must fail this test: the savingRef guard.
    const { when, findJournalsSpy } = await renderUnsaved();
    const folder = { getFileHandle: vi.fn() } as unknown as FsDirectoryHandle;
    let answer!: (dir: FsDirectoryHandle) => void;
    const pickSpy = vi
      .spyOn(await import('@/lib/fs-writer'), 'pickRecordingDirectory')
      .mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const saveSpy = vi.spyOn(await import('@/lib/take-recovery'), 'saveRecoveredTake').mockResolvedValue({
      files: [],
      json: 'sync_rec-1.json',
      chapters: false,
    });
    try {
      fireEvent.click(saveButton(when));
      fireEvent.click(saveButton(when));
      answer(folder);
      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
      await settle();

      expect(pickSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    } finally {
      pickSpy.mockRestore();
      saveSpy.mockRestore();
      findJournalsSpy.mockRestore();
    }
  });

  it('keeps the row and says so when the sync file could not be written', async () => {
    // Removal that must fail this test: the result.json === null branch.
    const { when, findJournalsSpy } = await renderUnsaved();
    const folder = { getFileHandle: vi.fn() } as unknown as FsDirectoryHandle;
    const pickSpy = vi
      .spyOn(await import('@/lib/fs-writer'), 'pickRecordingDirectory')
      .mockResolvedValue(folder);
    const saveSpy = vi.spyOn(await import('@/lib/take-recovery'), 'saveRecoveredTake').mockResolvedValue({
      files: [{ name: 'guest_r.mp4', bytes: 1024, source: 'journal' }],
      json: null,
      chapters: false,
      kept: true,
    });
    try {
      fireEvent.click(saveButton(when));
      const line = await screen.findByRole('alert');

      expect(line.textContent).toBe(
        'Saved 1 file to your folder. The sync file could not be written. The unsaved recording is still here: try again, or choose another folder.'
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.getByText(`Recording from ${when}`)).toBeInTheDocument();
    } finally {
      pickSpy.mockRestore();
      saveSpy.mockRestore();
      findJournalsSpy.mockRestore();
    }
  });

  it('keeps the row and names the files that were not saved', async () => {
    const { when, findJournalsSpy } = await renderUnsaved();
    const folder = { getFileHandle: vi.fn() } as unknown as FsDirectoryHandle;
    const pickSpy = vi
      .spyOn(await import('@/lib/fs-writer'), 'pickRecordingDirectory')
      .mockResolvedValue(folder);
    const saveSpy = vi.spyOn(await import('@/lib/take-recovery'), 'saveRecoveredTake').mockResolvedValue({
      files: [
        { name: 'guest_r.mp4', bytes: 1024, source: 'journal' },
        { name: 'host_r.mp4', bytes: 2048, source: 'backup' },
        { name: 'guest2_r.mp4', bytes: 512, source: 'failed', reason: 'rebuilt only in part' },
        { name: 'guest2_r.wav', bytes: 0, source: 'failed', reason: 'nothing was committed' },
      ],
      json: 'sync_rec-1.json',
      chapters: false,
      kept: true,
      unsaved: ['guest2_r.mp4'],
    });
    try {
      fireEvent.click(saveButton(when));
      const line = await screen.findByRole('alert');

      expect(line.textContent).toBe(
        'Saved 2 files to your folder. Not saved: guest2_r.mp4. ' +
          'The unsaved recording is still here: try again, or choose another folder.'
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.getByText(`Recording from ${when}`)).toBeInTheDocument();
      // The row can be saved again.
      expect(saveButton(when)).not.toBeDisabled();
    } finally {
      pickSpy.mockRestore();
      saveSpy.mockRestore();
      findJournalsSpy.mockRestore();
    }
  });

  it('says so when the host’s own file could not be copied, though the rest was saved', async () => {
    const { when, findJournalsSpy } = await renderUnsaved();
    const folder = { getFileHandle: vi.fn() } as unknown as FsDirectoryHandle;
    const pickSpy = vi
      .spyOn(await import('@/lib/fs-writer'), 'pickRecordingDirectory')
      .mockResolvedValue(folder);
    const saveSpy = vi.spyOn(await import('@/lib/take-recovery'), 'saveRecoveredTake').mockResolvedValue({
      files: [
        { name: 'guest_r.mp4', bytes: 1024, source: 'journal' },
        { name: 'host_r.mp4', bytes: 0, source: 'failed', reason: 'backup unavailable' },
      ],
      json: 'sync_rec-1.json',
      chapters: false,
      unsaved: ['host_r.mp4'],
    });
    try {
      fireEvent.click(saveButton(when));
      const line = await screen.findByRole('alert');

      expect(line.textContent).toBe('Saved 1 file to your folder. Not saved: host_r.mp4.');
      expect(screen.queryByText(`Recording from ${when}`)).not.toBeInTheDocument();
    } finally {
      pickSpy.mockRestore();
      saveSpy.mockRestore();
      findJournalsSpy.mockRestore();
    }
  });

  it('holds Save and Delete back while a rebuild runs, and says it is running', async () => {
    const { when, findJournalsSpy } = await renderUnsaved();
    const folder = { getFileHandle: vi.fn() } as unknown as FsDirectoryHandle;
    const pickSpy = vi
      .spyOn(await import('@/lib/fs-writer'), 'pickRecordingDirectory')
      .mockResolvedValue(folder);
    let finish!: (result: { files: []; json: string; chapters: boolean }) => void;
    const saveSpy = vi
      .spyOn(await import('@/lib/take-recovery'), 'saveRecoveredTake')
      .mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const deleteSpy = vi
      .spyOn(await import('@/lib/take-journal'), 'deleteTakeJournal')
      .mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteButton = () => screen.getByRole('button', { name: `Delete unsaved recording from ${when}` });
    try {
      fireEvent.click(saveButton(when));
      const running = await screen.findByText(
        'Saving the recording to your folder. Keep this tab open until it finishes.'
      );

      expect(running).toHaveAttribute('role', 'status');
      expect(saveButton(when)).toBeDisabled();
      expect(deleteButton()).toBeDisabled();
      fireEvent.click(deleteButton());
      await settle();
      expect(confirm).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();

      await act(async () => { finish({ files: [], json: 'sync_rec-1.json', chapters: false }); });
      expect(screen.queryByText(/^Saving the recording/)).not.toBeInTheDocument();
      expect(screen.queryByText(`Recording from ${when}`)).not.toBeInTheDocument();
    } finally {
      pickSpy.mockRestore();
      saveSpy.mockRestore();
      deleteSpy.mockRestore();
      confirm.mockRestore();
      findJournalsSpy.mockRestore();
    }
  });

  for (const press of ['save', 'delete'] as const) {
    it(`does not ${press} under a take another tab started after this page opened`, async () => {
      const { request } = takeHeldElsewhere();
      let recording = false;
      request.mockImplementation(async (name: string, _opts: unknown, cb: (lock: unknown) => unknown) =>
        cb(recording && name === 'openmeet-take:xyz-abcd-pqr' ? null : {})
      );
      const { when, findJournalsSpy } = await renderUnsaved();
      const folder = { getFileHandle: vi.fn() } as unknown as FsDirectoryHandle;
      const pickSpy = vi
        .spyOn(await import('@/lib/fs-writer'), 'pickRecordingDirectory')
        .mockResolvedValue(folder);
      const saveSpy = vi.spyOn(await import('@/lib/take-recovery'), 'saveRecoveredTake').mockResolvedValue({
        files: [],
        json: 'sync_rec-1.json',
        chapters: false,
      });
      const deleteSpy = vi
        .spyOn(await import('@/lib/take-journal'), 'deleteTakeJournal')
        .mockResolvedValue(undefined);
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      try {
        // The row was listed with the lock free; a take starts in another tab.
        recording = true;
        fireEvent.click(
          press === 'save'
            ? saveButton(when)
            : screen.getByRole('button', { name: `Delete unsaved recording from ${when}` })
        );
        const line = await screen.findByRole('alert');

        expect(line.textContent).toBe(
          'Another tab in this browser is recording this room, so nothing was changed here. ' +
            'End that recording, then reload this page.'
        );
        expect(screen.queryByText(`Recording from ${when}`)).not.toBeInTheDocument();
        expect(saveSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();
      } finally {
        pickSpy.mockRestore();
        saveSpy.mockRestore();
        deleteSpy.mockRestore();
        confirm.mockRestore();
        findJournalsSpy.mockRestore();
      }
    });
  }

  it('still deletes an unsaved recording beside Save', async () => {
    // Removal that must fail this test: the Delete button's onClick.
    const { journal, when, findJournalsSpy } = await renderUnsaved();
    const deleteSpy = vi
      .spyOn(await import('@/lib/take-journal'), 'deleteTakeJournal')
      .mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      fireEvent.click(screen.getByRole('button', { name: `Delete unsaved recording from ${when}` }));
      await waitFor(() => expect(screen.queryByText(`Recording from ${when}`)).not.toBeInTheDocument());

      expect(deleteSpy).toHaveBeenCalledWith(journal.dirName);
    } finally {
      deleteSpy.mockRestore();
      confirm.mockRestore();
      findJournalsSpy.mockRestore();
    }
  });

  it('lists an unfinished recording whose record cannot be read', async () => {
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([
      fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs: 1759824000000 }, 1_000_000, false),
    ]);
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const when = new Date(1759824000000).toLocaleString();
      const row = await screen.findByText(`Recording from ${when}`);
      expect(row.parentElement?.textContent).toMatch(/· 1 MB$/);
    } finally {
      findJournalsSpy.mockRestore();
    }
  });

  it('shows no unsaved recording on the producer or present-only pages', async () => {
    const findJournalsSpy = vi.spyOn(await import('@/lib/take-journal'), 'findTakeJournals').mockResolvedValue([
      fakeJournal(JOURNAL_A, { room: 'xyz-abcd-pqr', hostStartMs: 1759824000000 }, 2_500_000_000),
    ]);
    try {
      const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} producer />);
      await waitFor(() => expect(findJournalsSpy).toHaveBeenCalled());
      await settle();
      expect(screen.queryByRole('heading', { name: 'Unsaved recording' })).not.toBeInTheDocument();
      unmount();
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} present />);
      await settle();
      expect(screen.queryByRole('heading', { name: 'Unsaved recording' })).not.toBeInTheDocument();
    } finally {
      findJournalsSpy.mockRestore();
    }
  });

  it('shows no backups on the producer or present-only pages', async () => {
    const file = new File(['a'], 'openmeet-backup-1700000000000-xyz-abcd-pqr.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([file]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} producer />);
      await waitFor(() => expect(findBackupsSpy).toHaveBeenCalled());
      await settle();
      expect(screen.queryByRole('heading', { name: 'Backups on this device' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Send to host:/ })).toBeNull();
      unmount();

      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} present />);
      await settle();
      expect(screen.queryByRole('heading', { name: 'Backups on this device' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Send to host:/ })).toBeNull();
    } finally {
      findBackupsSpy.mockRestore();
    }
  });

  it('shows guest recording disclosure when viewer is not host', async () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(screen.getByText(/The host can record this call/i)).toBeInTheDocument();
    expect(screen.getByText(/camera, mic and chat are/i)).toBeInTheDocument();
    expect(screen.queryByText(/You can record this call/i)).not.toBeInTheDocument();
    // Let the in-flight getUserMedia/enumerateDevices chain settle so it
    // doesn't update state after the test (and its act() scope) has returned.
    await waitFor(() => expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled());
  });

  it('shows host recording disclosure when viewer is host (host token present)', async () => {
    localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      expect(screen.getByText(/You can record this call/i)).toBeInTheDocument();
      expect(screen.queryByText(/The host can record this call/i)).not.toBeInTheDocument();
      await waitFor(() => expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled());
    } finally {
      localStorage.removeItem('om_host_xyz-abcd-pqr');
    }
  });

  it('copyLink copies origin and pathname without query string', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    window.history.pushState({}, '', '/r/xyz-abcd-pqr/?producer=1');

    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} producer />);
    const copyBtn = screen.getByRole('button', { name: /copy invite link/i });
    fireEvent.click(copyBtn);

    expect(writeText).toHaveBeenCalledWith(`${location.origin}/r/xyz-abcd-pqr/`);
  });

  it('producer copy in lobby says watching and not recorded, with no recording claim or quality picker', async () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} producer />);
    expect(screen.getByText(/You’ll watch the call without being recorded/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/recording quality/i)).toBeNull();
    expect(screen.queryByText(/capturing/i)).toBeNull();
    expect(screen.queryByText(/The host can record this call/i)).toBeNull();
    expect(screen.queryByText(/You can record this call/i)).toBeNull();
    // A producer publishes nothing, so the lobby never opens (and lights) the camera.
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /join as a producer/i })).toBeInTheDocument();
  });

  it('lets a producer join with a name alone, with a stream that has no tracks', () => {
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} producer />);
    const join = screen.getByRole('button', { name: /join now/i });
    expect(join).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Pat' } });
    expect(join).not.toBeDisabled();
    fireEvent.click(join);
    expect(onJoin).toHaveBeenCalledTimes(1);
    const [stream, name, companion] = onJoin.mock.calls[0]!;
    expect(name).toBe('Pat');
    expect(companion).toBeUndefined();
    expect(stream.getTracks()).toHaveLength(0);
  });

  // A producer joins recvonly and never sends the screen it picked, so the
  // people already in the room would never see it.
  it('offers a producer no Present only, even on a ?present=1 link', () => {
    navigator.mediaDevices.getDisplayMedia = vi.fn();
    const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} producer />);
    expect(screen.queryByRole('button', { name: /present only/i })).toBeNull();
    unmount();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} producer present />);
    expect(screen.queryByRole('button', { name: /share screen/i })).toBeNull();
    expect(screen.getByRole('heading', { name: /join as a producer/i })).toBeInTheDocument();
  });

  it('estimates disk for the preset the camera can deliver, not a remembered one it cannot', async () => {
    // A 720p webcam, with 4K remembered from another machine. The picker can only
    // offer 720p, so the estimate must be for 720p too — not for a hidden 4K.
    localStorage.setItem('om_quality', '4k');
    try {
      vi.stubGlobal('navigator', {
        userAgent: 'test',
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue(cam720Stream()),
          enumerateDevices: vi.fn().mockResolvedValue(DEVICES),
        },
        storage: { estimate: vi.fn().mockResolvedValue({ quota: 20e9, usage: 0 }) },
      });
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const expected = diskCheck(20e9, 0, presetById('720p')).message;
      // The DOM query collapses the message's non-breaking space.
      await waitFor(() => expect(screen.getByText(expected.replace(/\s+/g, ' '))).toBeInTheDocument());
      expect(screen.getByLabelText('Recording quality')).toHaveValue('720p');
    } finally {
      localStorage.removeItem('om_quality');
    }
  });

  // The host's storage holds the take's crash journal; a guest's does not, so
  // only the host is told the take will have no crash copy.
  it('tells a host when the take cannot keep a crash copy, and never a guest', async () => {
    localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
    try {
      vi.stubGlobal('navigator', {
        userAgent: 'test',
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue(cam720Stream()),
          enumerateDevices: vi.fn().mockResolvedValue(DEVICES),
        },
        storage: { estimate: vi.fn().mockResolvedValue({ quota: 1e9, usage: 0 }) },
      });
      const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await waitFor(() => expect(screen.getByText(/without that copy/)).toBeInTheDocument());
      unmount();

      localStorage.removeItem('om_host_xyz-abcd-pqr');
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await waitFor(() => expect(screen.getByText(/under an hour at this quality/)).toBeInTheDocument());
      expect(screen.queryByText(/without that copy/)).toBeNull();
    } finally {
      localStorage.removeItem('om_host_xyz-abcd-pqr');
    }
  });

  // Lobby's isHost starts false and is set by its own effect, so a panel that
  // is already on screen has to learn the host flag later.
  it('re-runs the disk check when the host flag arrives after the first render', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      storage: { estimate: vi.fn().mockResolvedValue({ quota: 1e9, usage: 0 }) },
    });
    const { rerender } = render(
      <PreflightPanel slug="xyz-abcd-pqr" stream={null} qualityId="720p" bitrateId="standard" isHost={false} />
    );
    await waitFor(() => expect(screen.getByText(/under an hour at this quality/)).toBeInTheDocument());
    expect(screen.queryByText(/without that copy/)).toBeNull();
    rerender(<PreflightPanel slug="xyz-abcd-pqr" stream={null} qualityId="720p" bitrateId="standard" isHost />);
    await waitFor(() => expect(screen.getByText(/without that copy/)).toBeInTheDocument());
  });

  it('does not promise 24-bit uncompressed audio when this browser cannot capture a WAV master', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue(cam720Stream());
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const line = await screen.findByText(/Capturing 1280x720/);
    expect(line.textContent).not.toMatch(/uncompressed/i);
    expect(line.textContent).toMatch(/audio \(compressed\)/);
    expect(line.textContent).not.toMatch(/kHz/);
  });

  it('states 24-bit uncompressed audio when the WAV master is available', async () => {
    vi.stubGlobal('MediaStreamTrackProcessor', class {});
    try {
      (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue(cam720Stream(30, 44100));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const line = await screen.findByText(/Capturing 1280x720/);
      expect(line.textContent).toMatch(/audio 48kHz\/24-bit mono uncompressed/);
    } finally {
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
    }
  });

  // The control is only offered where it can change the recording: a two-channel
  // microphone in a browser that captures the uncompressed WAV master.
  it('offers the audio channel picker only when a stereo microphone and a WAV master are both there', async () => {
    try {
      vi.stubGlobal('MediaStreamTrackProcessor', class {});
      stubDevices(cam720Stream());
      const plain = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await screen.findByLabelText('Recording quality');
      expect(screen.queryByLabelText('Audio channels')).toBeNull();
      plain.unmount();

      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
      stubDevices(cam720Stream(30, 48000, 2));
      const noMaster = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await screen.findByLabelText('Recording quality');
      expect(screen.queryByLabelText('Audio channels')).toBeNull();
      noMaster.unmount();

      vi.stubGlobal('MediaStreamTrackProcessor', class {});
      stubDevices(cam720Stream(30, 48000, 2));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const select = await screen.findByLabelText('Audio channels');
      expect(select).toHaveValue('mono');
      expect(select.closest('label')?.className).toMatch(/focus-within:ring/);
      // Full width in the same grid, right after the microphone picker, and a
      // plain setting rather than a notice.
      expect(select.closest('label')?.className).toMatch(/sm:col-span-2/);
      expect(select.closest('label')).not.toHaveAttribute('role');
      expect(select.closest('label')?.previousElementSibling?.querySelector('select')).toHaveAttribute(
        'aria-label',
        'Microphone'
      );
    } finally {
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
    }
  });

  it('remembers the audio channel choice, and does not re-open the microphone to change it', async () => {
    vi.stubGlobal('MediaStreamTrackProcessor', class {});
    try {
      localStorage.removeItem('om_stereo');
      stubDevices(cam720Stream(30, 48000, 2));
      const first = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      fireEvent.change(await screen.findByLabelText('Audio channels'), { target: { value: 'stereo' } });
      expect(localStorage.getItem('om_stereo')).toBe('1');
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
      first.unmount();

      const second = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await waitFor(() => expect(screen.getByLabelText('Audio channels')).toHaveValue('stereo'));
      fireEvent.change(screen.getByLabelText('Audio channels'), { target: { value: 'mono' } });
      expect(localStorage.getItem('om_stereo')).toBe('0');
      second.unmount();

      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      expect(await screen.findByLabelText('Audio channels')).toHaveValue('mono');
    } finally {
      localStorage.removeItem('om_stereo');
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
    }
  });

  // A microphone that cannot feed stereo hides the control; the saved choice
  // stays for the next one that can.
  it('hides the audio channel picker when the microphone changes to a mono one, and keeps the choice', async () => {
    vi.stubGlobal('MediaStreamTrackProcessor', class {});
    try {
      localStorage.removeItem('om_stereo');
      vi.stubGlobal('navigator', {
        userAgent: 'test',
        mediaDevices: {
          getUserMedia: vi
            .fn()
            .mockResolvedValueOnce(cam720Stream(30, 48000, 2))
            .mockResolvedValueOnce(cam720Stream(30, 48000))
            .mockResolvedValueOnce(cam720Stream(30, 48000, 2)),
          enumerateDevices: vi.fn().mockResolvedValue([
            { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
            { kind: 'audioinput', deviceId: 'mic1', label: 'Stereo mic' },
            { kind: 'audioinput', deviceId: 'mic2', label: 'Mono mic' },
          ]),
        },
      });
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      fireEvent.change(await screen.findByLabelText('Audio channels'), { target: { value: 'stereo' } });

      fireEvent.change(screen.getByLabelText('Microphone'), { target: { value: 'mic2' } });
      await waitFor(() => expect(screen.queryByLabelText('Audio channels')).toBeNull());
      expect(screen.getByText(/Capturing 1280x720/).textContent).toMatch(/24-bit mono uncompressed/);
      expect(localStorage.getItem('om_stereo')).toBe('1');

      fireEvent.change(screen.getByLabelText('Microphone'), { target: { value: 'mic1' } });
      expect(await screen.findByLabelText('Audio channels')).toHaveValue('stereo');
    } finally {
      localStorage.removeItem('om_stereo');
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
    }
  });

  // Storage can be blocked outright; the lobby still opens, in mono.
  it('opens in mono when storage cannot be read', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.stubGlobal('MediaStreamTrackProcessor', class {});
    try {
      stubDevices(cam720Stream(30, 48000, 2));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      expect(await screen.findByLabelText('Audio channels')).toHaveValue('mono');
    } finally {
      getItem.mockRestore();
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
    }
  });

  it('sizes the estimate and the caption for the channels the choice records', async () => {
    vi.stubGlobal('MediaStreamTrackProcessor', class {});
    try {
      localStorage.removeItem('om_stereo');
      stubDevices(cam720Stream(30, 48000, 2));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const quality = await screen.findByLabelText('Recording quality');
      expect(quality.textContent).toContain(formatPerHour(presetById('720p'), 1));
      expect((await screen.findByText(/Capturing 1280x720/)).textContent).toMatch(
        /audio 48kHz\/24-bit mono uncompressed/
      );

      fireEvent.change(screen.getByLabelText('Audio channels'), { target: { value: 'stereo' } });
      expect(screen.getByLabelText('Recording quality').textContent).toContain(
        formatPerHour(presetById('720p'), 2)
      );
      expect(screen.getByText(/Capturing 1280x720/).textContent).toMatch(/24-bit stereo uncompressed/);
    } finally {
      localStorage.removeItem('om_stereo');
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
    }
  });

  it('hands the audio channel choice to onJoin', async () => {
    const onJoin = vi.fn();
    vi.stubGlobal('MediaStreamTrackProcessor', class {});
    try {
      localStorage.removeItem('om_stereo');
      stubDevices(cam720Stream(30, 48000, 2));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
      fireEvent.change(await screen.findByLabelText('Audio channels'), { target: { value: 'stereo' } });
      const join = screen.getByRole('button', { name: /join now/i });
      await waitFor(() => expect(join).not.toBeDisabled());
      fireEvent.click(join);

      await waitFor(() =>
        expect(onJoin).toHaveBeenCalledWith(expect.anything(), 'Alice', false, undefined, true)
      );
    } finally {
      localStorage.removeItem('om_stereo');
      delete (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
    }
  });

  it('labels each backup row with its time and room, and names every control after its row', async () => {
    const a = new File(['a'], 'openmeet-backup-1700000000000-abc-defg-hij.mp4', { lastModified: 1700000000000 });
    const b = new File(['b'], 'openmeet-backup-host-1700000100000-klm-nopq-rst.mp4', { lastModified: 1700000100000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([b, a]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();

    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

    const whenA = new Date(a.lastModified).toLocaleString();
    const whenB = new Date(b.lastModified).toLocaleString();
    await screen.findByText(`Recording backup (MP4) from ${whenA} in room abc-defg-hij`);
    expect(screen.getByText(`Recording backup (MP4) from ${whenB} in room klm-nopq-rst`)).toBeInTheDocument();
    // Two rows, two distinct names per control — a screen reader can tell them apart.
    expect(screen.getByRole('link', { name: `Download backup (MP4) from ${whenA} in room abc-defg-hij` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Delete backup (MP4) from ${whenB} in room klm-nopq-rst` })).toBeInTheDocument();

    findBackupsSpy.mockRestore();
  });

  it('shows a visible focus ring on the camera, microphone and quality pickers', async () => {
    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue(DEVICES);
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    for (const name of ['Camera', 'Microphone', 'Recording quality', 'Recording bitrate', 'Frame rate']) {
      const select = await screen.findByLabelText(name);
      // The select drops its native outline, so its visible box must take over.
      expect(select.closest('label')?.className).toMatch(/focus-within:ring/);
    }
  });

  it('gives the name field a real label that survives typing', async () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const input = screen.getByPlaceholderText(/your name/i) as HTMLInputElement;
    expect(input.labels?.[0]?.textContent).toBe('Your name');
    await waitFor(() => expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled());
  });

  it('informs user that Brave works as host only after enabling brave://flags/#file-system-access-api and does not list Brave as a plain working host', async () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => false };
    localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const msg = await screen.findByText(/Recording needs a Chromium browser/i);
      expect(msg.textContent).toMatch(/brave:\/\/flags\/#file-system-access-api/);
      expect(msg.textContent).not.toMatch(/\(Chrome, Edge, Brave\)/);
      expect(msg.textContent).toMatch(/Brave works as host only after enabling/i);
    } finally {
      delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
      localStorage.removeItem('om_host_xyz-abcd-pqr');
    }
  });

  // The Brave flag only matters to a host (it is about saving files); a guest
  // just needs to know they won't be recorded and what to do about it.
  it('tells a guest on a browser that cannot record what that means for them, without host-only flags', async () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => false };
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const msg = await screen.findByText(/This browser can’t record you/);
      expect(msg.textContent).toMatch(/Chrome or Edge/);
      expect(screen.queryByText(/brave:\/\/flags/)).toBeNull();
    } finally {
      delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    }
  });

  it('shows guest on Safari "Safari: video only, no uncompressed WAV" before joining', async () => {
    const safariUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15';
    vi.stubGlobal('navigator', {
      userAgent: safariUa,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await waitFor(() => {
        expect(screen.getByText(/Safari: video only, no uncompressed WAV/i)).toBeInTheDocument();
      });
    } finally {
      delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    }
  });

  it('shows guest on iPhone "iPhone/iPad: keep the tab in front, recording stops in the background" before joining', async () => {
    const iphoneUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
    vi.stubGlobal('navigator', {
      userAgent: iphoneUa,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await waitFor(() => {
        expect(
          screen.getByText(/iPhone\/iPad: keep the tab in front, recording stops in the background/i)
        ).toBeInTheDocument();
      });
    } finally {
      delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    }
  });

  it('lists WAV backups alongside camera backups and labels them distinguishably', async () => {
    const cameraBackup = new File(['camera-data'], 'openmeet-backup-1700000000000-room-xyz.mp4', {
      lastModified: 1700000000000,
    });
    const wavBackup = new File(['wav-data'], 'openmeet-backup-audio-1700000000000-room-xyz.wav', {
      lastModified: 1700000000000,
    });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups')
      .mockResolvedValue([cameraBackup, wavBackup]);

    URL.createObjectURL = vi.fn().mockImplementation((file: File) => `blob:http://localhost/${file.name}`);
    URL.revokeObjectURL = vi.fn();

    render(<Lobby slug="xyz" onJoin={vi.fn()} />);

    const when = new Date(1700000000000).toLocaleString();
    await screen.findByText(`Recording backup (MP4) from ${when} in room room-xyz`);
    expect(screen.getByText(`Recording backup (WAV) from ${when} in room room-xyz`)).toBeInTheDocument();

    const cameraDownload = screen.getByRole('link', { name: `Download backup (MP4) from ${when} in room room-xyz` });
    const wavDownload = screen.getByRole('link', { name: `Download backup (WAV) from ${when} in room room-xyz` });
    expect(cameraDownload).toHaveAttribute('download', 'openmeet-backup-1700000000000-room-xyz.mp4');
    expect(wavDownload).toHaveAttribute('download', 'openmeet-backup-audio-1700000000000-room-xyz.wav');

    findBackupsSpy.mockRestore();
  });

  it("the lobby's Present-only click calls getDisplayMedia before join and joins with companion=true and no camera/mic tracks", async () => {
    const fakeScreen = {
      getTracks: () => [{ kind: 'video', stop: vi.fn() }],
      getVideoTracks: () => [{ kind: 'video', stop: vi.fn() }],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const getDisplayMedia = vi.fn().mockResolvedValue(fakeScreen);
    navigator.mediaDevices.getDisplayMedia = getDisplayMedia;

    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);

    // Present only button exists and is disabled when name is blank
    const presentBtn = screen.getByRole('button', { name: /present only/i });
    expect(presentBtn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Bob' } });
    expect(presentBtn).not.toBeDisabled();

    fireEvent.click(presentBtn);
    await waitFor(() => expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true }));
    await waitFor(() => expect(onJoin).toHaveBeenCalled());

    const [stream, name, companion, screenStream] = onJoin.mock.calls[0]!;
    expect(name).toBe('Bob');
    expect(companion).toBe(true);
    expect(stream.getTracks()).toHaveLength(0);
    expect(screenStream).toBe(fakeScreen);
  });

  it('?present=1 never calls getUserMedia', async () => {
    const getUserMedia = vi.fn();
    navigator.mediaDevices.getUserMedia = getUserMedia;
    navigator.mediaDevices.getDisplayMedia = vi.fn();
    window.history.replaceState({}, '', '/r/xyz-abcd-pqr?present=1');

    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} present={true} />);
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /share screen/i })).toBeInTheDocument();
      expect(screen.getByText(/This device joins only to share its screen — no camera or mic/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /join now/i })).toBeNull();
      expect(screen.getByPlaceholderText(/your name/i)).toBeInTheDocument();
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('hides Present-only button in lobby when screen share is not supported', () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(screen.getByRole('button', { name: /join now/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /present only/i })).toBeNull();
  });

  it('replaces Present-only button with unsupported message on device without screen share support', () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} present={true} />);
    expect(screen.queryByRole('button', { name: /present only/i })).toBeNull();
    expect(
      screen.getByText("This device can't share its screen — open this link on a computer.")
    ).toBeInTheDocument();
  });

  it('shows Present-only button when screen share is supported, saying what it does', () => {
    navigator.mediaDevices.getDisplayMedia = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(screen.getByRole('button', { name: /present only/i })).toHaveAccessibleDescription(
      /only to share a screen, with no camera or mic/
    );
  });

  it('shows recording disclosure in present-only mode for guest', async () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} present={true} />);
    await waitFor(() => expect(screen.getByText(/The host can record this call/i)).toBeInTheDocument());
  });

  it('shows recording disclosure in present-only mode for host', async () => {
    localStorage.setItem('om_host_host-room', 'token-123');
    try {
      render(<Lobby slug="host-room" onJoin={vi.fn()} present={true} />);
      await waitFor(() => expect(screen.getByText(/You can record this call/i)).toBeInTheDocument());
    } finally {
      localStorage.removeItem('om_host_host-room');
    }
  });

  it('says what to do when the camera and mic are blocked, and Try again starts them', async () => {
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Camera and mic are blocked');
    // No live toggles for devices that aren't captured, and Join says why it waits.
    expect(screen.queryByRole('button', { name: /turn off microphone/i })).toBeNull();
    expect(screen.getByText('Join opens once your camera and mic are on.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /turn off microphone/i })).toBeInTheDocument());
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Camera and mic are blocked')).toBeNull();
    expect(screen.queryByText('Join opens once your camera and mic are on.')).toBeNull();
  });

  it('names a busy camera as busy, not as a permission problem', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' })
    );
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(await screen.findByText('Camera or mic is busy')).toBeInTheDocument();
    expect(screen.getByText(/Close it \(Zoom, Teams, another call\), then try again\./)).toBeInTheDocument();
  });

  it('asks for camera and mic while the browser prompt is still open', () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(screen.getByText('Allow camera and mic')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('button', { name: /turn off camera/i })).toBeNull();
  });

  it('clears a failed device switch once a later switch works', async () => {
    const devices = [...DEVICES, { kind: 'videoinput', deviceId: 'cam2', label: 'USB cam' }];
    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue(devices);
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const camera = await screen.findByLabelText('Camera');

    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'OverconstrainedError' }));
    fireEvent.change(camera, { target: { value: 'cam2' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/no camera or microphone found/i);

    fireEvent.change(camera, { target: { value: 'cam2' } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(camera).toHaveValue('cam2');
  });

  it('joins on Enter in the name field', async () => {
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    const input = screen.getByPlaceholderText(/your name/i);
    await screen.findByRole('button', { name: /turn off microphone/i });
    // No name yet: Enter does nothing.
    fireEvent.submit(input.closest('form')!);
    expect(onJoin).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() =>
      expect(onJoin).toHaveBeenCalledWith(expect.anything(), 'Alice', false, undefined, false)
    );
  });

  /** A browser where another tab holds this room's take lock. */
  function takeHeldElsewhere() {
    const stream = fakeStream();
    const request = vi.fn(async (name: string, _opts: unknown, cb: (lock: unknown) => unknown) =>
      cb(name === 'openmeet-take:xyz-abcd-pqr' ? null : {})
    );
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      locks: { request },
    });
    return { stream, request };
  }
  const settle = () => act(async () => {});

  it('asks before joining while another tab records this room, and stays in the lobby on a no', async () => {
    const { stream } = takeHeldElsewhere();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onJoin = vi.fn();
    try {
      const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
      const join = screen.getByRole('button', { name: /join now/i });
      await waitFor(() => expect(join).not.toBeDisabled());
      fireEvent.click(join);
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      expect(confirm.mock.calls[0]![0]).toMatch(/^Another tab in this browser is recording this room\./);
      expect(confirm.mock.calls[0]![0]).toMatch(/press End & save in the other tab/);
      await settle();
      expect(onJoin).not.toHaveBeenCalled();
      for (const t of stream.getTracks()) expect(t.stop).not.toHaveBeenCalled();
      fireEvent.click(join);
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
      await settle();
      expect(onJoin).not.toHaveBeenCalled();
      // Still the lobby's stream: leaving the page turns the camera off.
      unmount();
      for (const t of stream.getTracks()) expect(t.stop).toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it('joins when the person answers yes', async () => {
    const { stream } = takeHeldElsewhere();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onJoin = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
      const join = screen.getByRole('button', { name: /join now/i });
      await waitFor(() => expect(join).not.toBeDisabled());
      fireEvent.click(join);
      await waitFor(() => expect(onJoin).toHaveBeenCalled());
      expect(onJoin.mock.calls[0]!.slice(0, 2)).toEqual([stream, 'Alice']);
      // The stream is handed over once, however often Join is pressed after that.
      fireEvent.click(join);
      await settle();
      expect(onJoin).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      confirm.mockRestore();
    }
  });

  it('Present only asks after the screen picker, and gives the screen back on a no', async () => {
    const { stream } = takeHeldElsewhere();
    const track = { kind: 'video', stop: vi.fn() };
    const getDisplayMedia = vi.fn().mockResolvedValue({
      getTracks: () => [track],
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
    });
    navigator.mediaDevices.getDisplayMedia = getDisplayMedia;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onJoin = vi.fn();
    try {
      const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Bob' } });
      await waitFor(() => expect(screen.getByRole('button', { name: /join now/i })).not.toBeDisabled());
      fireEvent.click(screen.getByRole('button', { name: /present only/i }));
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      expect(getDisplayMedia.mock.invocationCallOrder[0]!).toBeLessThan(confirm.mock.invocationCallOrder[0]!);
      await settle();
      expect(onJoin).not.toHaveBeenCalled();
      expect(track.stop).toHaveBeenCalled();
      // The camera preview is still live, and still the lobby's to turn off.
      for (const t of stream.getTracks()) expect(t.stop).not.toHaveBeenCalled();
      unmount();
      for (const t of stream.getTracks()) expect(t.stop).toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it('does not ask a producer', async () => {
    takeHeldElsewhere();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onJoin = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} producer />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Pat' } });
      fireEvent.click(screen.getByRole('button', { name: /join now/i }));
      await settle();
      expect(confirm).not.toHaveBeenCalled();
      expect(onJoin).toHaveBeenCalledTimes(1);
    } finally {
      confirm.mockRestore();
    }
  });

  it('joins once when Join is pressed twice before the check answers', async () => {
    const { request } = takeHeldElsewhere();
    // Every check stays open until the test answers it: "not held".
    const answers: (() => void)[] = [];
    request.mockImplementation(
      (_name: string, _opts: unknown, cb: (lock: unknown) => unknown) =>
        new Promise((resolve) => {
          answers.push(() => resolve(cb({})));
        })
    );
    const onJoin = vi.fn();
    render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} />);
    fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
    const join = screen.getByRole('button', { name: /join now/i });
    await waitFor(() => expect(join).not.toBeDisabled());
    fireEvent.click(join);
    fireEvent.click(join);
    for (const answer of answers) answer();
    await settle();
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('mirrors the self-preview, but not a rear camera', async () => {
    const { container, unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByRole('button', { name: /turn off camera/i });
    expect(container.querySelector('video')?.className).toMatch(/-scale-x-100/);
    unmount();

    const rear = { kind: 'video', enabled: true, stop: vi.fn(), getSettings: () => ({ facingMode: 'environment' }) };
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue({
      getTracks: () => [rear],
      getAudioTracks: () => [],
      getVideoTracks: () => [rear],
    });
    const { container: c2 } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByRole('button', { name: /turn off camera/i });
    expect(c2.querySelector('video')?.className).not.toMatch(/-scale-x-100/);
  });

  it('links the logo home, as on the landing page', () => {
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'openMeet home' })).toHaveAttribute('href', '/');
  });

  it('gives only the host the recording-folder figure', async () => {
    const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    await screen.findByText(/Wear headphones/);
    expect(screen.queryByText(/^Recording folder:/)).toBeNull();
    unmount();

    localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      expect(await screen.findByText(/^Recording folder: about [\d.]+ GB per hour for 4 people/)).toBeInTheDocument();
    } finally {
      localStorage.removeItem('om_host_xyz-abcd-pqr');
    }
  });

  // On a phone the checklist is below Join, so a silent mic would go unseen.
  // A room used every week collects old backups, and sending all of them
  // unasked could be many gigabytes.
  it('offers Send to host on this room’s guest backups only', async () => {
    const mine = new File(['a'], 'openmeet-backup-1700000000000-xyz-abcd-pqr.mp4', { lastModified: 1700000000000 });
    const otherRoom = new File(['b'], 'openmeet-backup-1700000001000-abc-defg-hij.mp4', { lastModified: 1700000001000 });
    const noRoom = new File(['c'], 'openmeet-backup.mp4', { lastModified: 1700000002000 });
    const hostOwn = new File(['d'], 'openmeet-backup-host-1700000003000-xyz-abcd-pqr.mp4', { lastModified: 1700000003000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups')
      .mockResolvedValue([mine, otherRoom, noRoom, hostOwn]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} onSendBackups={vi.fn()} />);
      const send = await screen.findByRole('button', { name: /^Send to host:/ });
      expect(send).toHaveAccessibleName(/^Send to host: backup \(MP4\) from .* in room xyz-abcd-pqr$/);
      expect(send).toHaveAttribute('type', 'button');
      expect(send).not.toHaveClass('bg-[#0b57d0]/10');
      expect(screen.getAllByRole('button', { name: /^Send to host:/ })).toHaveLength(1);
      // Between the row's other two controls, and wrapping with them on a phone.
      const row = send.closest('li')!;
      const download = within(row).getByRole('link', { name: /^Download / });
      const remove = within(row).getByRole('button', { name: /^Delete / });
      expect(download.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(send.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(send.parentElement!.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
      unmount();

      // A host's own screen backup has a guest's name shape; the token is what
      // keeps the button off it.
      localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} onSendBackups={vi.fn()} />);
      await screen.findByRole('heading', { name: 'Backups on this device' });
      expect(screen.queryByRole('button', { name: /^Send to host:/ })).toBeNull();
    } finally {
      localStorage.removeItem('om_host_xyz-abcd-pqr');
      findBackupsSpy.mockRestore();
    }
  });

  it('marks a chosen backup and says it will go to the host, and undoes both on a second press', async () => {
    const file = new File(['a'], 'openmeet-backup-1700000000000-xyz-abcd-pqr.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([file]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} onSendBackups={vi.fn()} />);
      const send = await screen.findByRole('button', { name: /^Send to host:/ });
      expect(send).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(send);
      expect(send).toHaveTextContent('Will send to host');
      expect(send).toHaveAttribute('aria-pressed', 'true');
      expect(send).toHaveClass('bg-[#0b57d0]/10');
      expect(screen.getByRole('status')).toHaveTextContent(
        'Sent to the host after you join, once they’re in the room and accept. Keep the tab open until it finishes.'
      );

      fireEvent.click(send);
      expect(send).toHaveTextContent('Send to host');
      expect(send).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      findBackupsSpy.mockRestore();
    }
  });

  it('sends the chosen backup to the host just before joining', async () => {
    const file = new File(['a'], 'openmeet-backup-1700000000000-xyz-abcd-pqr.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([file]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    const onSendBackups = vi.fn();
    const onJoin = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} onSendBackups={onSendBackups} />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
      const join = screen.getByRole('button', { name: /join now/i });
      await waitFor(() => expect(join).not.toBeDisabled());
      fireEvent.click(await screen.findByRole('button', { name: /^Send to host:/ }));
      fireEvent.click(join);

      await waitFor(() =>
        expect(onJoin).toHaveBeenCalledWith(expect.anything(), 'Alice', false, undefined, false)
      );
      expect(onSendBackups).toHaveBeenCalledWith([file]);
      expect(onSendBackups.mock.invocationCallOrder[0]!).toBeLessThan(onJoin.mock.invocationCallOrder[0]!);
    } finally {
      findBackupsSpy.mockRestore();
    }
  });

  it('sends nothing when no backup was chosen', async () => {
    const file = new File(['a'], 'openmeet-backup-1700000000000-xyz-abcd-pqr.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([file]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    const onSendBackups = vi.fn();
    const onJoin = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} onSendBackups={onSendBackups} />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
      const join = screen.getByRole('button', { name: /join now/i });
      await waitFor(() => expect(join).not.toBeDisabled());
      await screen.findByRole('button', { name: /^Send to host:/ });
      fireEvent.click(join);

      await waitFor(() =>
        expect(onJoin).toHaveBeenCalledWith(expect.anything(), 'Alice', false, undefined, false)
      );
      expect(onSendBackups).not.toHaveBeenCalled();
    } finally {
      findBackupsSpy.mockRestore();
    }
  });

  it('drops a chosen backup that was deleted before joining', async () => {
    const file = new File(['a'], 'openmeet-backup-1700000000000-xyz-abcd-pqr.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([file]);
    const deleteBackupSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'deleteBackup').mockResolvedValue(undefined);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSendBackups = vi.fn();
    const onJoin = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} onSendBackups={onSendBackups} />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
      const join = screen.getByRole('button', { name: /join now/i });
      await waitFor(() => expect(join).not.toBeDisabled());
      fireEvent.click(await screen.findByRole('button', { name: /^Send to host:/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Delete / }));
      await waitFor(() => expect(screen.queryByRole('button', { name: /^Send to host:/ })).toBeNull());

      fireEvent.click(join);
      await waitFor(() =>
        expect(onJoin).toHaveBeenCalledWith(expect.anything(), 'Alice', false, undefined, false)
      );
      expect(onSendBackups).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
      deleteBackupSpy.mockRestore();
      findBackupsSpy.mockRestore();
    }
  });

  it('sends the chosen backup when the guest joins Present only', async () => {
    const file = new File(['a'], 'openmeet-backup-1700000000000-xyz-abcd-pqr.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([file]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    const track = { kind: 'video', stop: vi.fn() };
    navigator.mediaDevices.getDisplayMedia = vi.fn().mockResolvedValue({
      getTracks: () => [track],
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
    });
    const onSendBackups = vi.fn();
    const onJoin = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} onSendBackups={onSendBackups} />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Bob' } });
      await waitFor(() => expect(screen.getByRole('button', { name: /join now/i })).not.toBeDisabled());
      fireEvent.click(await screen.findByRole('button', { name: /^Send to host:/ }));
      fireEvent.click(screen.getByRole('button', { name: /present only/i }));

      await waitFor(() => expect(onJoin).toHaveBeenCalledWith(expect.anything(), 'Bob', true, expect.anything()));
      expect(onSendBackups).toHaveBeenCalledWith([file]);
      expect(onSendBackups.mock.invocationCallOrder[0]!).toBeLessThan(onJoin.mock.invocationCallOrder[0]!);
    } finally {
      findBackupsSpy.mockRestore();
    }
  });

  it('sends no backup when the takeover question is answered no', async () => {
    takeHeldElsewhere();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const file = new File(['a'], 'openmeet-backup-1700000000000-xyz-abcd-pqr.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([file]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    const onSendBackups = vi.fn();
    const onJoin = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={onJoin} onSendBackups={onSendBackups} />);
      fireEvent.change(screen.getByPlaceholderText(/your name/i), { target: { value: 'Alice' } });
      const join = screen.getByRole('button', { name: /join now/i });
      await waitFor(() => expect(join).not.toBeDisabled());
      fireEvent.click(await screen.findByRole('button', { name: /^Send to host:/ }));
      fireEvent.click(join);

      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      await settle();
      expect(onSendBackups).not.toHaveBeenCalled();
      expect(onJoin).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
      findBackupsSpy.mockRestore();
    }
  });

  it('stops at eight chosen backups at a time, and says so', async () => {
    const files = Array.from(
      { length: 9 },
      (_, i) => new File([`f${i}`], `openmeet-backup-${1700000000000 + i}-xyz-abcd-pqr.mp4`, { lastModified: 1700000000000 + i })
    );
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue(files);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} onSendBackups={vi.fn()} />);
      const buttons = await screen.findAllByRole('button', { name: /^Send to host:/ });
      expect(buttons).toHaveLength(9);

      for (const button of buttons.slice(0, 8)) fireEvent.click(button);
      expect(buttons[8]).toBeDisabled();
      expect(buttons[8]).toHaveClass('disabled:cursor-not-allowed', 'disabled:opacity-50');
      expect(screen.getByRole('status')).toHaveTextContent(
        'Sent to the host after you join, once they’re in the room and accept. Keep the tab open until it finishes. You can send 8 at a time.'
      );

      fireEvent.click(buttons[0]!);
      expect(buttons[8]).not.toBeDisabled();
    } finally {
      findBackupsSpy.mockRestore();
    }
  });

  it('tells a guest with a backup of this room to press Send to host, and leaves the host’s own text alone', async () => {
    const file = new File(['a'], 'openmeet-backup-1700000000000-xyz-abcd-pqr.mp4', { lastModified: 1700000000000 });
    const findBackupsSpy = vi.spyOn(await import('@/lib/backup-recorder'), 'findBackups').mockResolvedValue([file]);
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} onSendBackups={vi.fn()} />);
      expect(await screen.findByText(/press Send to host on the matching backup and join/)).toBeInTheDocument();
      unmount();

      localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} onSendBackups={vi.fn()} />);
      expect(await screen.findByText(/guests, send it to the host/)).toBeInTheDocument();
      expect(screen.queryByText(/press Send to host on the matching backup and join/)).toBeNull();
    } finally {
      localStorage.removeItem('om_host_xyz-abcd-pqr');
      findBackupsSpy.mockRestore();
    }
  });

  it('points to the checks from the Join panel when the mic stays silent', async () => {
    class FakeAudioContext {
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(b: Float32Array) { b.fill(0); } }; }
      close() { return Promise.resolve(); }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    // An MP4 encoder, so the silent mic is the only failure.
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const realNow = Date.now;
    let skew = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    try {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      expect(await screen.findByText('Checking your setup…')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /fix before recording/i })).toBeNull();

      skew = 2000; // past the listening window, still silent
      const link = await screen.findByRole('link', { name: /fix before recording/i });
      expect(link).toHaveAttribute('href', '#preflight');
      expect(document.getElementById('preflight')).toHaveTextContent(/No sound detected/);
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  describe('frame rate', () => {
    const gum = () => navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    const lastVideo = () => gum().mock.calls.at(-1)![0].video as MediaTrackConstraints;
    const firstVideo = () => gum().mock.calls[0]![0].video as MediaTrackConstraints;

    beforeEach(() => {
      (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        ...DEVICES,
        { kind: 'videoinput', deviceId: 'cam2', label: 'USB cam' },
      ]);
    });
    afterEach(() => localStorage.removeItem('om_fps'));

    /** The lobby with its preview up, returning the frame-rate select. */
    async function renderWithPicker() {
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      return await screen.findByLabelText('Frame rate');
    }

    it('offers 24, 25, 29.97 and 30 fps, starting at 30', async () => {
      gum().mockResolvedValue(cam720Stream(30, undefined, undefined, 30));
      const picker = await renderWithPicker();
      expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'Frame rate: 24 fps',
        'Frame rate: 25 fps',
        'Frame rate: 29.97 fps',
        'Frame rate: 30 fps',
      ]);
      expect(picker).toHaveValue('30');
      expect(lastVideo().frameRate).toEqual({ ideal: 30 });
    });

    it('adds 50 and 60 on a camera that reaches them, and asks for the pick', async () => {
      gum().mockResolvedValue(cam720Stream(30, undefined, undefined, 60));
      const picker = await renderWithPicker();
      expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'Frame rate: 24 fps',
        'Frame rate: 25 fps',
        'Frame rate: 29.97 fps',
        'Frame rate: 30 fps',
        'Frame rate: 50 fps',
        'Frame rate: 60 fps',
      ]);

      fireEvent.change(picker, { target: { value: '60' } });
      await waitFor(() => expect(localStorage.getItem('om_fps')).toBe('60'));
      expect(lastVideo().frameRate).toEqual({ ideal: 60 });
    });

    it('shows a remembered rate the camera cannot reach as the best it can do, without a false alarm', async () => {
      localStorage.setItem('om_fps', '60');
      gum().mockResolvedValue(cam720Stream(30, undefined, undefined, 30));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

      await screen.findByText(/Capturing 1280x720/);
      expect(screen.getByLabelText('Frame rate')).toHaveValue('30');
      // The pick stays in state and is still what the camera is asked for.
      expect(firstVideo().frameRate).toEqual({ ideal: 60 });
      expect(screen.queryByText(/This camera gives/)).toBeNull();
      expect(screen.queryByText(/need a faster computer/)).toBeNull();
    });

    it('measures a shortfall against the rate the picker shows', async () => {
      localStorage.setItem('om_fps', '60');
      gum().mockResolvedValue(cam720Stream(15, undefined, undefined, 30));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

      expect(
        await screen.findByText('This camera gives 15 fps at this quality, not 30.')
      ).toBeInTheDocument();
    });

    it('states the cost when the camera delivers a high rate', async () => {
      localStorage.setItem('om_fps', '60');
      gum().mockResolvedValue(cam720Stream(59.94005994, undefined, undefined, 60));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

      const note = await screen.findByText(
        '50 and 60 fps need a faster computer and make the video files larger. If the picture stutters, pick a lower frame rate.'
      );
      expect(note).toHaveAttribute('role', 'status');
      expect(screen.getByLabelText('Frame rate')).toHaveValue('60');
      expect(screen.queryByText(/This camera gives/)).toBeNull();
    });

    it('follows what the camera delivers, not the pick, for the cost note', async () => {
      localStorage.setItem('om_fps', '60');
      gum().mockResolvedValue(cam720Stream(30, undefined, undefined, 60));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

      expect(
        await screen.findByText('This camera gives 30 fps at this quality, not 60.')
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Frame rate')).toHaveValue('60');
      expect(screen.queryByText(/need a faster computer/)).toBeNull();
    });

    it('asks the camera for the picked rate and remembers it', async () => {
      const picker = await renderWithPicker();
      fireEvent.change(picker, { target: { value: '29.97' } });
      await waitFor(() => expect(localStorage.getItem('om_fps')).toBe('29.97'));
      expect(lastVideo().frameRate).toEqual({ ideal: 29.97 });
      expect(picker).toHaveValue('29.97');
    });

    it('starts at a rate remembered in this browser', async () => {
      localStorage.setItem('om_fps', '24');
      const picker = await renderWithPicker();
      expect(picker).toHaveValue('24');
      // The first preview, not a later switch: a remembered rate is asked for
      // from the moment the camera opens.
      expect(firstVideo().frameRate).toEqual({ ideal: 24 });
    });

    it('ignores a remembered rate that is not on offer', async () => {
      localStorage.setItem('om_fps', '999');
      const picker = await renderWithPicker();
      expect(picker).toHaveValue('30');
      expect(firstVideo().frameRate).toEqual({ ideal: 30 });
    });

    it('keeps the rate when the camera or the quality changes', async () => {
      const picker = await renderWithPicker();
      fireEvent.change(picker, { target: { value: '25' } });
      // The handlers read state, so the switches below wait for this to settle.
      await waitFor(() => expect(picker).toHaveValue('25'));

      fireEvent.change(screen.getByLabelText('Camera'), { target: { value: 'cam2' } });
      await waitFor(() => expect(lastVideo().deviceId).toEqual({ exact: 'cam2' }));
      expect(lastVideo().frameRate).toEqual({ ideal: 25 });

      fireEvent.change(screen.getByLabelText('Recording quality'), { target: { value: '720p' } });
      await waitFor(() => expect(lastVideo().width).toEqual({ ideal: 1280 }));
      expect(lastVideo().frameRate).toEqual({ ideal: 25 });
      expect(picker).toHaveValue('25');
    });

    it('changes nothing when the camera refuses the switch', async () => {
      const picker = await renderWithPicker();
      gum().mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'NotReadableError' }));
      fireEvent.change(picker, { target: { value: '25' } });
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('busy'));
      expect(picker).toHaveValue('30');
      expect(localStorage.getItem('om_fps')).toBeNull();
    });

    it('asks for the remembered rate when Try again starts the preview', async () => {
      localStorage.setItem('om_fps', '25');
      gum().mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
      expect(await screen.findByLabelText('Frame rate')).toHaveValue('25');
      expect(gum()).toHaveBeenCalledTimes(2);
      expect(lastVideo().frameRate).toEqual({ ideal: 25 });
    });

    it('says the camera gives another rate than the pick, with both figures exact', async () => {
      gum().mockResolvedValue(cam720Stream(14.985014915466309));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

      const notice = await screen.findByText('This camera gives 14.985 fps at this quality, not 30.');
      expect(notice).toHaveAttribute('role', 'status');
      expect(screen.getByText(/Capturing 1280x720 @ 14\.985fps/)).toBeInTheDocument();
    });

    it('compares the delivered rate with the pick, not with the default', async () => {
      localStorage.setItem('om_fps', '24');
      gum().mockResolvedValue(cam720Stream(30));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

      expect(
        await screen.findByText('This camera gives 30 fps at this quality, not 24.')
      ).toBeInTheDocument();
    });

    it('stays quiet when the camera delivers the pick, within half a frame', async () => {
      const pairs: [string, number][] = [
        ['30', 30.000030517578125],
        ['24', 24],
        ['29.97', 30],
        ['30', 30.4],
      ];
      for (const [picked, delivered] of pairs) {
        localStorage.setItem('om_fps', picked);
        gum().mockResolvedValue(cam720Stream(delivered));
        const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
        await screen.findByText(/Capturing 1280x720/);
        expect(screen.queryByText(/This camera gives/)).toBeNull();
        unmount();
      }
    });

    it('reports a difference of more than half a frame, half a frame exactly being the same mode', async () => {
      gum().mockResolvedValue(cam720Stream(30.6));
      const { unmount } = render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      expect(
        await screen.findByText('This camera gives 30.6 fps at this quality, not 30.')
      ).toBeInTheDocument();
      unmount();

      gum().mockResolvedValue(cam720Stream(30.5));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      await screen.findByText(/Capturing 1280x720/);
      expect(screen.queryByText(/This camera gives/)).toBeNull();
    });

    it('stays quiet when the track reports no usable rate, and prints no rate', async () => {
      gum().mockResolvedValue(cam720Stream(0));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

      expect(await screen.findByText(/Capturing 1280x720 · audio/)).toBeInTheDocument();
      expect(screen.queryByText(/This camera gives/)).toBeNull();
    });

    it('sits under the Capturing line, at the same size and alignment', async () => {
      gum().mockResolvedValue(cam720Stream(14.985014915466309));
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);

      const capturing = await screen.findByText(/Capturing 1280x720 @ 14\.985fps/);
      const notice = await screen.findByText('This camera gives 14.985 fps at this quality, not 30.');
      expect(capturing.nextElementSibling).toBe(notice);
      expect(notice.className).toMatch(/\bmt-1\b/);
      expect(notice.className).toMatch(/\btext-xs\b/);
      expect(notice.className).toMatch(/\btext-center\b/);
      expect(notice.className).toMatch(/text-\[#7a4f01\]/);
    });

    describe('size figures', () => {
      // A camera of the given size that delivers `frameRate`.
      const cam = (width: number, height: number, frameRate: number) => {
        const audio = { kind: 'audio', enabled: true, stop: vi.fn(), getSettings: () => ({ sampleRate: 48000 }) };
        const video = {
          kind: 'video',
          enabled: true,
          stop: vi.fn(),
          getSettings: () => ({ width, height, frameRate }),
          getCapabilities: () => ({ width: { max: width }, height: { max: height } }),
        };
        return {
          getTracks: () => [audio, video],
          getAudioTracks: () => [audio],
          getVideoTracks: () => [video],
        } as unknown as MediaStream;
      };
      const lobbyWith = (stream: MediaStream) => {
        const estimate = vi.fn().mockResolvedValue({ quota: 20e9, usage: 0 });
        vi.stubGlobal('navigator', {
          userAgent: 'test',
          mediaDevices: {
            getUserMedia: vi.fn().mockResolvedValue(stream),
            enumerateDevices: vi
              .fn()
              .mockResolvedValue([...DEVICES, { kind: 'videoinput', deviceId: 'cam2', label: 'USB cam' }]),
          },
          storage: { estimate },
        });
        localStorage.setItem('om_host_xyz-abcd-pqr', 'host-tok');
        render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
        return estimate;
      };
      // The DOM query collapses the message's non-breaking space.
      const shown = (message: string) => screen.findByText(message.replace(/\s+/g, ' '));
      const optionTexts = (label: string) =>
        [...(screen.getByLabelText(label) as HTMLSelectElement).options].map((o) => o.textContent);

      afterEach(() => {
        for (const key of ['om_host_xyz-abcd-pqr', 'om_quality', 'om_bitrate']) localStorage.removeItem(key);
      });

      it('grows every figure for a camera that delivers 60 fps', async () => {
        const estimate = lobbyWith(cam(1280, 720, 60));
        const p = presetAt(presetById('720p'), 60);

        expect(await shown(diskCheck(20e9, 0, p).message)).toBeInTheDocument();
        expect(await shown(folderCheck(p).message)).toBeInTheDocument();
        expect(optionTexts('Recording quality')).toEqual([
          `Quality: 720p · ${formatPerHour(p, 1)} per person`,
        ]);
        expect(optionTexts('Recording bitrate')[0]).toBe(
          `Bitrate: Standard · up to ${p.videoBps / 1e6} Mbps`
        );
        expect(estimate).toHaveBeenCalledTimes(1);
      });

      it('leaves every figure as it was for a camera that delivers 30 fps', async () => {
        lobbyWith(cam(1280, 720, 30));
        const p = presetById('720p');

        expect(await shown(diskCheck(20e9, 0, p).message)).toBeInTheDocument();
        expect(await shown(folderCheck(p).message)).toBeInTheDocument();
        expect(optionTexts('Recording quality')).toEqual([
          `Quality: 720p · ${formatPerHour(p, 1)} per person`,
        ]);
        expect(optionTexts('Recording bitrate')[0]).toBe(
          `Bitrate: Standard · up to ${p.videoBps / 1e6} Mbps`
        );
      });

      it('follows the delivered rate when the camera changes', async () => {
        lobbyWith(cam(1280, 720, 30));
        await shown(diskCheck(20e9, 0, presetById('720p')).message);

        (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue(
          cam(1280, 720, 60)
        );
        fireEvent.change(screen.getByLabelText('Camera'), { target: { value: 'cam2' } });

        expect(
          await shown(diskCheck(20e9, 0, presetAt(presetById('720p'), 60)).message)
        ).toBeInTheDocument();
      });

      it('applies the bitrate level before the frame rate, as the recorder does', async () => {
        localStorage.setItem('om_quality', '1440p');
        localStorage.setItem('om_bitrate', 'max');
        lobbyWith(cam(2560, 1440, 60));
        const p = presetAt(atBitrate(presetById('1440p'), 'max'), 60);

        expect(await shown(diskCheck(20e9, 0, p).message)).toBeInTheDocument();
        expect(await shown(folderCheck(p).message)).toBeInTheDocument();
        expect(optionTexts('Recording quality').at(-1)).toBe(
          `Quality: 1440p · ${formatPerHour(p, 1)} per person`
        );
        expect(optionTexts('Recording bitrate').at(-1)).toBe(
          `Bitrate: Maximum · up to ${p.videoBps / 1e6} Mbps`
        );
      });
    });
  });
});

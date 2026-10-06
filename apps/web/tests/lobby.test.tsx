import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Lobby } from '@/components/Lobby';
import { diskCheck } from '@/lib/preflight';
import { presetById } from '@/lib/quality';

function fakeStream(): MediaStream {
  const tracks = [{ kind: 'audio', enabled: true, stop: vi.fn() }, { kind: 'video', enabled: true, stop: vi.fn() }];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}

/** A real-looking 720p webcam: settings AND capabilities, so presets get filtered. */
function cam720Stream(): MediaStream {
  const audio = { kind: 'audio', enabled: true, stop: vi.fn(), getSettings: () => ({ sampleRate: 48000 }) };
  const video = {
    kind: 'video',
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }),
    getCapabilities: () => ({ width: { max: 1280 }, height: { max: 720 } }),
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
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith(expect.anything(), 'Alice'));
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
      expect(title.parentElement?.textContent).toMatch(/· 1 MB$/);

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

  it('does not promise 24-bit uncompressed audio when this browser cannot capture a WAV master', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue(cam720Stream());
    render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
    const line = await screen.findByText(/Capturing 1280x720/);
    expect(line.textContent).not.toMatch(/uncompressed/i);
  });

  it('states 24-bit uncompressed audio when the WAV master is available', async () => {
    vi.stubGlobal('MediaStreamTrackProcessor', class {});
    try {
      (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue(cam720Stream());
      render(<Lobby slug="xyz-abcd-pqr" onJoin={vi.fn()} />);
      const line = await screen.findByText(/Capturing 1280x720/);
      expect(line.textContent).toMatch(/48kHz\/24-bit uncompressed/);
    } finally {
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
    for (const name of ['Camera', 'Microphone', 'Recording quality']) {
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
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith(expect.anything(), 'Alice'));
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
});

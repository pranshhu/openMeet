import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionSummary, type SummaryFile } from '@/components/SessionSummary';
import { buildSyncReport } from '@/lib/sync-report';

describe('SessionSummary', () => {
  const baseProps = {
    files: [
      { name: 'host_r.mp4', kind: 'video' as const },
      { name: 'guest_r.mp4', kind: 'video' as const },
    ],
    markers: [],
    warnings: [],
    integrity: { ok: true, text: 'Integrity verified — bytes written match bytes sent (sha256).' },
    alignment: 'Guest started 100 ms AFTER host.',
    commands: [],
    syncReportUrl: 'blob:sync',
    chaptersUrl: null,
    backupUrl: 'blob:backup',
    wavBackupUrl: null,
    downloadNames: {
      sync: 'openmeet-abc-defg-hij-take1-sync.json',
      chapters: 'openmeet-abc-defg-hij-take1-chapters.txt',
      backup: 'openmeet-abc-defg-hij-take1-backup-priya.mp4',
      wav: 'openmeet-abc-defg-hij-take1-backup-priya.wav',
    },
    takes: [],
    onNewTake: vi.fn(),
    onDiscardTake: vi.fn(),
  };

  it('renders files for 1 guest (host and guest files)', () => {
    render(<SessionSummary {...baseProps} />);
    expect(screen.getByText('host_r.mp4')).toBeInTheDocument();
    expect(screen.getByText('guest_r.mp4')).toBeInTheDocument();
  });

  // An unbreakable file name set the summary's min-content width, so on a
  // phone the whole column grew past the screen.
  it('lets long file names wrap instead of widening the summary', () => {
    render(<SessionSummary {...baseProps} />);
    const name = screen.getByText('host_r.mp4');
    expect(name.className).toMatch(/\bmin-w-0\b/);
    expect(name.className).toMatch(/\bbreak-words\b/);
  });

  it('renders files for 2 guests', () => {
    const files: SummaryFile[] = [
      { name: 'host_r.mp4', kind: 'video' },
      { name: 'guest_r.mp4', kind: 'video' },
      { name: 'guest2_r.mp4', kind: 'video' },
      { name: 'host_r.wav', kind: 'audio' },
      { name: 'guest_r.wav', kind: 'audio' },
      { name: 'guest2_r.wav', kind: 'audio' },
    ];
    render(<SessionSummary {...baseProps} files={files} />);
    expect(screen.getByText('host_r.mp4')).toBeInTheDocument();
    expect(screen.getByText('guest_r.mp4')).toBeInTheDocument();
    expect(screen.getByText('guest2_r.mp4')).toBeInTheDocument();
    expect(screen.getByText('host_r.wav')).toBeInTheDocument();
    expect(screen.getByText('guest_r.wav')).toBeInTheDocument();
    expect(screen.getByText('guest2_r.wav')).toBeInTheDocument();
  });

  it('handles WAV-less guest with warning and without WAV file in list', () => {
    const files: SummaryFile[] = [
      { name: 'host_r.mp4', kind: 'video' },
      { name: 'guest_r.mp4', kind: 'video' },
      { name: 'host_r.wav', kind: 'audio' },
    ];
    render(
      <SessionSummary
        {...baseProps}
        files={files}
        warnings={['no WAV master for Bob']}
      />
    );
    expect(screen.getByText('host_r.mp4')).toBeInTheDocument();
    expect(screen.getByText('guest_r.mp4')).toBeInTheDocument();
    expect(screen.getByText('host_r.wav')).toBeInTheDocument();
    expect(screen.queryByText('guest_r.wav')).toBeNull();
    expect(screen.getByText('no WAV master for Bob')).toBeInTheDocument();
  });

  it('renders screen segments with their start offsets', () => {
    const files: SummaryFile[] = [
      { name: 'host_r.mp4', kind: 'video' },
      { name: 'host_screen_r.mp4', kind: 'screen', detail: '+5000ms' },
      { name: 'guest_screen_r_2.mp4', kind: 'screen', detail: '+27000ms' },
    ];
    render(<SessionSummary {...baseProps} files={files} />);
    expect(screen.getByText('host_screen_r.mp4')).toBeInTheDocument();
    expect(screen.getByText('guest_screen_r_2.mp4')).toBeInTheDocument();
    expect(screen.getByText(/Screen.*\+5000ms/)).toBeInTheDocument();
    expect(screen.getByText(/Screen.*\+27000ms/)).toBeInTheDocument();
  });

  it('shows file size after kind when bytes is present and shows no size when bytes is absent', () => {
    const files: SummaryFile[] = [
      { name: 'host_r.mp4', kind: 'video', bytes: 812_300_000 },
      { name: 'guest_r.mp4', kind: 'video' },
      { name: 'host_r.wav', kind: 'audio', bytes: 0 },
    ];
    render(<SessionSummary {...baseProps} files={files} />);
    expect(screen.getByText('Camera · 812 MB')).toBeInTheDocument();
    expect(screen.getByText('Camera')).toBeInTheDocument();
    expect(screen.getByText('Audio master (uncompressed) · 0 B')).toBeInTheDocument();
  });

  it('puts the size between the kind and the detail', () => {
    render(
      <SessionSummary
        {...baseProps}
        files={[{ name: 'host_screen_r.mp4', kind: 'screen', detail: 'Alice, +5000ms', bytes: 12_000_000 }]}
      />
    );
    expect(screen.getByText('Screen · 12 MB (Alice, +5000ms)')).toBeInTheDocument();
  });

  // The status is the first word of each verdict, so the tone is never the only
  // signal; a long unbroken name must still wrap inside the sheet.
  it.each([
    ['complete', 'text-[#81c995]'],
    ['unverified', 'text-[#fdd663]'],
    ['incomplete', 'text-[#f6aea9]'],
  ] as const)('shows a %s verdict as its own line in its tone', (status, tone) => {
    render(
      <SessionSummary
        {...baseProps}
        files={[{ name: 'guest_r.mp4', kind: 'video', verdict: { status, text: 'Verdict text here.' } }]}
      />
    );
    const line = screen.getByText('Verdict text here.');
    expect(line.className).toMatch(/\bbreak-words\b/);
    expect(line.className).toContain(tone);
  });

  // A take can list a dozen files; a dozen announcements at once help nobody.
  it('shows a verdict as plain text, not a live region', () => {
    render(
      <SessionSummary
        {...baseProps}
        files={[{ name: 'guest_r.mp4', kind: 'video', verdict: { status: 'incomplete', text: 'Verdict text here.' } }]}
      />
    );
    const line = screen.getByText('Verdict text here.');
    expect(line).not.toHaveAttribute('role');
    expect(line).not.toHaveAttribute('aria-live');
  });

  it('renders integrity-missing message once, not duplicated', () => {
    const integrityMsg = 'Integrity not verified — one of the digests is missing.';
    render(
      <SessionSummary
        {...baseProps}
        integrity={{ ok: false, text: integrityMsg }}
        warnings={[integrityMsg]}
      />
    );
    const matches = screen.getAllByText(integrityMsg);
    expect(matches).toHaveLength(1);
  });

  it('renders the roll-up warning once, not duplicated', () => {
    const rollUp = "Not every file is complete and verified (1 of 2). Each file's verdict says why.";
    render(
      <SessionSummary
        {...baseProps}
        integrity={{ ok: false, text: rollUp }}
        warnings={[rollUp]}
      />
    );
    const matches = screen.getAllByText(rollUp);
    expect(matches).toHaveLength(1);
  });

  it('clarifies that media files are on disk and sync.json/backup are downloads', () => {
    render(<SessionSummary {...baseProps} />);
    expect(
      screen.getByText(/2 files are in the folder you chose\. Nothing was uploaded\. sync\.json exists only in this tab/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Everything below is already on your disk/)
    ).toBeNull();
  });

  it('says the chapters are tab-only too when there are any', () => {
    render(<SessionSummary {...baseProps} chaptersUrl="blob:chapters" />);
    expect(screen.getByText(/sync\.json and the chapters exist only in this tab — download them/)).toBeInTheDocument();
  });

  it('shows the saved line when sidecarsSaved is true (without chapters)', () => {
    render(<SessionSummary {...baseProps} sidecarsSaved />);
    expect(
      screen.getByText(/The sync file and any chapters or chat for this take are saved there too\./)
    ).toBeInTheDocument();
    expect(screen.queryByText(/only in this tab/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Download sync.json' })).toBeInTheDocument();
  });

  it('shows the saved line when sidecarsSaved is true (with chapters)', () => {
    render(<SessionSummary {...baseProps} sidecarsSaved chaptersUrl="blob:chapters" />);
    expect(
      screen.getByText(/The sync file and any chapters or chat for this take are saved there too\./)
    ).toBeInTheDocument();
    expect(screen.queryByText(/only in this tab/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Download sync.json' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download chapters' })).toBeInTheDocument();
  });

  it('shows the old warning when sidecarsSaved is false', () => {
    render(<SessionSummary {...baseProps} sidecarsSaved={false} />);
    expect(
      screen.getByText(/sync\.json exists only in this tab — download it before you close the tab or record again\./)
    ).toBeInTheDocument();
  });

  // opacity on the row took Keep, the one way to undo a discard, to 2.7:1.
  it('dims only the label of a discarded take, not its Keep button', () => {
    render(<SessionSummary {...baseProps} takes={[{ take: 1, durationMs: 60_000, discarded: true }]} />);
    const keep = screen.getByRole('button', { name: 'Keep' });
    expect(keep.closest('[class*="opacity"]')).toBeNull();
    expect(screen.getByText('Take 1 · 1:00').className).toMatch(/line-through/);
  });

  it('shows WAV backup download link only when wavBackupUrl is provided', () => {
    const { rerender } = render(<SessionSummary {...baseProps} wavBackupUrl={null} />);
    expect(screen.queryByText('Download your WAV backup')).toBeNull();

    rerender(<SessionSummary {...baseProps} wavBackupUrl="blob:wav-backup" />);
    const link = screen.getByText('Download your WAV backup');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('blob:wav-backup');
    expect(link.getAttribute('download')).toBe('openmeet-abc-defg-hij-take1-backup-priya.wav');
  });

  // The next step and the one file that exists only in this tab came after four
  // screens of ffmpeg; the same downloads then repeated under other names.
  it('leads with the take and its next step, and folds the ffmpeg commands away', () => {
    const onNewTake = vi.fn();
    render(
      <SessionSummary
        {...baseProps}
        onNewTake={onNewTake}
        takes={[
          { take: 1, durationMs: 60_000, discarded: false },
          { take: 2, durationMs: 90_000, discarded: false },
        ]}
        commands={[{ label: 'Make the host file seekable (lossless)', cmd: 'ffmpeg -i host_r.mp4' }]}
      />
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Take 2 saved');
    const next = screen.getByRole('button', { name: 'Record another take' });
    const sync = screen.getByRole('link', { name: 'Download sync.json' });
    const files = screen.getByRole('heading', { name: 'Files' });
    expect(next.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sync.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sync.getAttribute('download')).toBe('openmeet-abc-defg-hij-take1-sync.json');
    expect(screen.getAllByRole('link', { name: /sync\.json/ })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: /backup/ })).toHaveLength(1);
    expect(screen.getByText('ffmpeg -i host_r.mp4').closest('details')?.open).toBe(false);
    fireEvent.click(next);
    expect(onNewTake).toHaveBeenCalledTimes(1);
  });

  it('shows take lengths as timecode, like the chapters, not raw seconds', () => {
    render(<SessionSummary {...baseProps} takes={[{ take: 1, durationMs: 2_700_000, discarded: false }]} />);
    expect(screen.getByText('Take 1 · 45:00')).toBeInTheDocument();
  });

  it('closes back to the call', () => {
    const onClose = vi.fn();
    render(<SessionSummary {...baseProps} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to the call' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the aligned-copy commands and what they do, from a real report', () => {
    const r = buildSyncReport({
      recordingId: 'r',
      hostFile: 'host_r.mp4',
      hostWavFile: 'host_r.wav',
      hostStartMs: 1_000_000,
      guests: [
        {
          slot: 0,
          name: 'Bob',
          file: 'guest_r.mp4',
          wavFile: 'guest_r.wav',
          startHostMs: 1_001_500,
          rttMs: 20,
        },
      ],
    });
    render(
      <SessionSummary
        {...baseProps}
        alignment={r.data.alignment}
        commands={r.data.commands}
      />
    );
    expect(
      screen.getByText(/The aligned-copy commands under Editor commands write copies/)
    ).toBeInTheDocument();
    const videoCmd =
      'ffmpeg -itsoffset 1.500 -i "guest_r.mp4" -c copy -tag:v avc1 -movflags +faststart "guest_r_aligned.mp4"';
    const cmdEl = screen.getByText(videoCmd);
    expect(cmdEl.closest('details')?.open).toBe(false);
    expect(
      screen.getByRole('button', {
        name: 'Copy: Bob: aligned copy of the video (starts 1.500 s in)',
      })
    ).toBeInTheDocument();
  });
});

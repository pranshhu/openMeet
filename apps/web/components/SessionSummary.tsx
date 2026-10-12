'use client';

import { useState } from 'react';
import { Icon } from './Icon';
import { formatBytes, formatTimecode } from '@/lib/sync-report';

/**
 * What you have, whether it's intact, and what to run next.
 *
 * We deliberately don't build an editor, which makes the handoff TO an editor
 * the product. Previously a session ended with files in a folder and no account
 * of what they were.
 */

import type { SummaryFile } from '@/lib/sync-report';
export type { SummaryFile };

const VERDICT_TONE = {
  complete: 'text-[#81c995]',
  unverified: 'text-[#fdd663]',
  incomplete: 'text-[#f6aea9]',
} as const;

export function SessionSummary({
  files,
  markers,
  warnings,
  integrity,
  alignment,
  commands,
  syncReportUrl,
  chaptersUrl,
  backupUrl,
  wavBackupUrl,
  downloadNames,
  takes,
  sidecarsSaved = false,
  onNewTake,
  nextTakeLabel = 'Record another take',
  onDiscardTake,
  onClose,
}: {
  files: SummaryFile[];
  markers: { at: string; label: string; from?: string; name?: string }[];
  warnings: string[];
  integrity: { ok: boolean; text: string } | null;
  alignment: string | null;
  commands: { label: string; cmd: string }[];
  syncReportUrl: string | null;
  chaptersUrl: string | null;
  backupUrl: string | null;
  wavBackupUrl: string | null;
  /** The download= names, so a take's files can be told apart once saved. */
  downloadNames: { sync: string; chapters: string; backup: string; wav: string };
  takes: { take: number; durationMs: number; discarded: boolean }[];
  sidecarsSaved?: boolean | undefined;
  onNewTake: () => void;
  nextTakeLabel?: string;
  onDiscardTake: (take: number) => void;
  onClose?: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  };

  const KIND: Record<SummaryFile['kind'], string> = {
    video: 'Camera',
    audio: 'Audio master (uncompressed)',
    screen: 'Screen',
    call: 'Call audio copy, lower quality',
  };
  const lastTake = takes[takes.length - 1];
  const secondary =
    'rounded-full border border-white/20 px-5 py-3 text-sm font-medium text-[#8ab4f8] transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]';
  // Underlined, not told apart by colour alone; nowrap moves a whole link to
  // the next line rather than splitting it.
  const link =
    'whitespace-nowrap rounded-sm text-[#8ab4f8] underline underline-offset-2 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]';

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 text-left text-sm">
      {/* What happened and the one next step first; the detail follows. */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <h2 className="pt-1 text-2xl font-normal tracking-tight text-white">
            {lastTake ? `Take ${lastTake.take} saved` : 'Recording saved'}
          </h2>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Back to the call"
              title="Back to the call"
              className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8] sm:h-9 sm:w-9"
            >
              <Icon name="close" size={20} />
            </button>
          )}
        </div>
        <p className="mt-2 text-white/70">
          {files.length} {files.length === 1 ? 'file is' : 'files are'} in the folder you chose. Nothing was uploaded.{' '}
          {sidecarsSaved ? (
            'The sync file and any chapters or chat for this take are saved there too.'
          ) : (
            <>
              {chaptersUrl ? 'sync.json and the chapters exist' : 'sync.json exists'} only in this tab — download{' '}
              {chaptersUrl ? 'them' : 'it'} before you close the tab or record again.
            </>
          )}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onNewTake}
            className="rounded-full bg-[#0b57d0] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0842a0] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
          >
            {nextTakeLabel}
          </button>
          {syncReportUrl && (
            <a href={syncReportUrl} download={downloadNames.sync} className={secondary}>
              Download sync.json
            </a>
          )}
          {chaptersUrl && (
            <a href={chaptersUrl} download={downloadNames.chapters} className={secondary}>
              Download chapters
            </a>
          )}
        </div>
        {backupUrl && (
          <p className="mt-3 text-xs text-white/60">
            Safety copies:{' '}
            <a href={backupUrl} download={downloadNames.backup} className={link}>
              Download your backup
            </a>
            {wavBackupUrl && (
              <>
                {' · '}
                <a href={wavBackupUrl} download={downloadNames.wav} className={link}>
                  Download your WAV backup
                </a>
              </>
            )}
          </p>
        )}
      </div>

      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-[#5c2b29] p-3 text-[#f6aea9]">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {integrity && (integrity.ok || !warnings.includes(integrity.text)) && (
        <p className={integrity.ok ? 'text-[#81c995]' : 'text-[#f6aea9]'}>{integrity.text}</p>
      )}

      <section>
        <h3 className="mb-2 font-medium text-white/80">Files</h3>
        <ul className="space-y-1">
          {/* Name above its kind: side by side, the label took half a narrow
              row and broke the name mid-UUID over three lines. At 12px a
              camera or WAV name with no person's name in it fits one line;
              a longer one breaks after a hyphen, keeping the extension with
              the last part. */}
          {files.map((f) => (
            <li key={f.name} className="flex flex-col gap-0.5 rounded-xl bg-white/5 px-3 py-2">
              <code className="min-w-0 break-words text-xs text-white/85">{f.name}</code>
              <span className="text-xs text-white/60">
                {KIND[f.kind]}
                {f.bytes !== undefined ? ` · ${formatBytes(f.bytes)}` : ''}
                {f.detail ? ` (${f.detail})` : ''}
              </span>
              {f.verdict && (
                <span className={`min-w-0 break-words text-xs ${VERDICT_TONE[f.verdict.status]}`}>{f.verdict.text}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {alignment && (
        <section>
          <h3 className="mb-1 font-medium text-white/80">Alignment</h3>
          {/* One line per guest, then the note on aligned copies when there are any. */}
          <p className="whitespace-pre-line text-white/60">{alignment}</p>
        </section>
      )}

      {markers.length > 0 && (
        <section>
          <h3 className="mb-2 font-medium text-white/80">Chapters</h3>
          <ul className="space-y-0.5 text-white/70">
            {markers.map((m, i) => {
              const by = m.name || m.from;
              return (
                <li key={`${m.at}-${i}`} className="break-words">
                  <span className="text-white/60">{m.at}</span> {m.label || 'Marker'}
                  {by && <span className="ml-2 text-xs text-white/60">— {by}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {takes.length > 0 && (
        <section>
          <h3 className="mb-2 font-medium text-white/80">Takes this session</h3>
          <ul className="space-y-1">
            {takes.map((t) => (
              // Only the label dims: fading the row took Keep, the one way to
              // undo a discard, below readable contrast.
              <li key={t.take} className="flex items-center justify-between gap-3 rounded-xl bg-white/5 py-1 pl-3 pr-1">
                <span className={t.discarded ? 'line-through text-white/60' : ''}>
                  Take {t.take} · {formatTimecode(t.durationMs)}
                </span>
                <button
                  type="button"
                  onClick={() => onDiscardTake(t.take)}
                  className="min-h-11 shrink-0 rounded-full px-3 py-1.5 text-xs text-white/70 sm:min-h-0 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
                >
                  {t.discarded ? 'Keep' : 'Mark discarded'}
                </button>
              </li>
            ))}
          </ul>
          {/* Marking only — the files stay on disk. Deleting someone's recording
              on their behalf is not a call this app gets to make. */}
          <p className="mt-1 text-xs text-white/60">
            Marking is a note to yourself; the files are never deleted.
          </p>
        </section>
      )}

      {/* Reference for the edit, not a next step: folded away by default. */}
      {commands.length > 0 && (
        <details className="rounded-2xl bg-white/5 p-4">
          <summary className="cursor-pointer rounded font-medium text-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]">
            Editor commands (ffmpeg)
          </summary>
          <ul className="mt-3 space-y-2">
            {commands.map((c) => (
              <li key={c.label}>
                <div className="mb-1 text-xs text-white/60">{c.label}</div>
                <div className="flex items-start gap-2 rounded bg-black/40 p-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs text-white/80">
                    {c.cmd}
                  </code>
                  <button
                    onClick={() => copy(c.label, c.cmd)}
                    className="shrink-0 rounded p-3.5 text-white/60 hover:bg-white/10 hover:text-white sm:p-1"
                    aria-label={`Copy: ${c.label}`}
                  >
                    <Icon name={copied === c.label ? 'check' : 'copy'} size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

'use client'

import { EXPORT_FORMATS, formatBytes, type ExportPrefs } from '@/lib/exportFormat'

/** Toolbar shown while the save panel is open: pick a format (and quality
 *  for the lossy ones), then download, copy or share the result. */
export default function ExportControls({
  prefs,
  webp,
  size,
  ready,
  canCopy,
  canShare,
  onPrefs,
  onDownload,
  onCopy,
  onShare,
  onDone,
  note,
}: {
  prefs: ExportPrefs
  /** False where the browser can't encode WebP (Safari). */
  webp: boolean
  /** Encoded size of the current choice; null while it's being rendered. */
  size: number | null
  ready: boolean
  canCopy: boolean
  canShare: boolean
  onPrefs: (patch: Partial<ExportPrefs>) => void
  onDownload: () => void
  onCopy: () => void
  onShare: () => void
  onDone: () => void
  /** A caveat about the current choice, shown under the format row. */
  note?: string
}) {
  const lossy = prefs.format !== 'png'
  return (
    <div className="pb-3 sm:pb-6">
      <div className="px-3 sm:px-6 pb-1.5 sm:pb-2 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
        {EXPORT_FORMATS.filter((f) => f.id !== 'webp' || webp).map((f) => (
          <button
            key={f.id}
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            data-active={prefs.format === f.id}
            aria-pressed={prefs.format === f.id}
            onClick={() => onPrefs({ format: f.id })}
          >
            {f.label}
          </button>
        ))}
        {lossy && (
          <div className="ctrl flex items-center gap-2 px-3 h-9 sm:h-10">
            <span className="label">quality</span>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={prefs.quality}
              onChange={(e) => onPrefs({ quality: Number(e.target.value) })}
              className="w-20 sm:w-28"
              aria-label="Quality"
            />
            <span className="label tabular-nums w-7 text-right">{prefs.quality}</span>
          </div>
        )}
        <span className="label text-ink-faint tabular-nums min-w-16 text-center" aria-live="polite">
          {size === null ? '…' : formatBytes(size)}
        </span>
      </div>
      {note && <p className="label text-ink-faint text-center pb-1.5 sm:pb-2">{note}</p>}
      <div className="px-3 sm:px-6 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
        <button type="button" className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer" onClick={onDone}>
          back
        </button>
        {canCopy && (
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={onCopy}
          >
            copy
          </button>
        )}
        {canShare && (
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={onShare}
            disabled={!ready}
          >
            share
          </button>
        )}
        <button
          type="button"
          onClick={onDownload}
          disabled={!ready}
          className="label px-6 sm:px-7 h-9 sm:h-10 cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
          style={{ background: 'var(--amber)', color: '#181612', fontWeight: 500 }}
        >
          download
        </button>
      </div>
    </div>
  )
}

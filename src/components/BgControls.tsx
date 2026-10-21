'use client'

export type BgFill = { kind: 'transparent' } | { kind: 'color'; color: string }

const CHECKER =
  'repeating-conic-gradient(#d9d6cf 0% 25%, #9c998f 0% 50%) 50% / 10px 10px'

/** CSS background for a fill: a checkerboard stands for transparency. */
export const bgCss = (b: BgFill) => (b.kind === 'transparent' ? CHECKER : b.color)

/** Toolbar shown while the background tool is open. */
export default function BgControls({
  bg,
  mode,
  brush,
  ready,
  canUndo,
  canRedo,
  onBg,
  onMode,
  onBrush,
  onUndo,
  onRedo,
  onTurnOff,
  onDone,
}: {
  bg: BgFill
  mode: 'keep' | 'remove'
  brush: number
  /** A cutout exists: refine and background controls are live. */
  ready: boolean
  canUndo: boolean
  canRedo: boolean
  onBg: (b: BgFill) => void
  onMode: (m: 'keep' | 'remove') => void
  onBrush: (v: number) => void
  onUndo: () => void
  onRedo: () => void
  onTurnOff: () => void
  onDone: () => void
}) {
  const swatch = (label: string, fill: BgFill, active: boolean) => (
    <button
      type="button"
      className="ctrl w-9 sm:w-10 h-9 sm:h-10 cursor-pointer flex items-center justify-center"
      data-active={active}
      aria-pressed={active}
      aria-label={label}
      title={label}
      disabled={!ready}
      onClick={() => onBg(fill)}
    >
      <span
        aria-hidden
        className="block w-5 h-5 border"
        style={{ background: bgCss(fill), borderColor: 'var(--line-strong)' }}
      />
    </button>
  )
  const custom = bg.kind === 'color' && bg.color !== '#ffffff' && bg.color !== '#000000'
  return (
    <div className="pb-3 sm:pb-6">
      <div className="px-3 sm:px-6 pb-1.5 sm:pb-2 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
        {swatch('Transparent background', { kind: 'transparent' }, bg.kind === 'transparent')}
        {swatch('White background', { kind: 'color', color: '#ffffff' }, bg.kind === 'color' && bg.color === '#ffffff')}
        {swatch('Black background', { kind: 'color', color: '#000000' }, bg.kind === 'color' && bg.color === '#000000')}
        <label
          className="ctrl w-9 sm:w-10 h-9 sm:h-10 cursor-pointer flex items-center justify-center"
          data-active={custom}
          title="Background color"
        >
          <input
            type="color"
            aria-label="Background color"
            className="w-5 h-5 cursor-pointer"
            disabled={!ready}
            value={custom && bg.kind === 'color' ? bg.color : '#e8a33d'}
            onChange={(e) => onBg({ kind: 'color', color: e.target.value })}
          />
        </label>
        <span aria-hidden className="w-px h-6 mx-1" style={{ background: 'var(--line)' }} />
        {(['keep', 'remove'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            data-active={mode === m}
            aria-pressed={mode === m}
            disabled={!ready}
            onClick={() => onMode(m)}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="px-3 sm:px-6 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
        <div className="ctrl flex items-center gap-2 sm:gap-3 px-3 sm:px-4 h-9 sm:h-10">
          <span className="label">brush</span>
          <input
            type="range"
            min={8}
            max={96}
            value={brush}
            disabled={!ready}
            onChange={(e) => onBrush(Number(e.target.value))}
            className="w-20 sm:w-24"
            aria-label="Brush size"
          />
        </div>
        <button type="button" className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer" onClick={onUndo} disabled={!canUndo}>
          undo
        </button>
        <button type="button" className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer" onClick={onRedo} disabled={!canRedo}>
          redo
        </button>
        <button type="button" className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer" onClick={onTurnOff} disabled={!ready}>
          turn off
        </button>
        <button
          type="button"
          onClick={onDone}
          className="label px-6 sm:px-7 h-9 sm:h-10 cursor-pointer"
          style={{ background: 'var(--amber)', color: '#181612', fontWeight: 500 }}
        >
          done
        </button>
      </div>
    </div>
  )
}

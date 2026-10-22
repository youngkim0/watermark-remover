'use client'

/** Toolbar shown while the mosaic tool is active. */
export default function MosaicControls({
  brush,
  level,
  canUndo,
  canRedo,
  onBrush,
  onLevel,
  onUndo,
  onRedo,
  onDone,
}: {
  brush: number
  /** Cell size, 1–10. */
  level: number
  canUndo: boolean
  canRedo: boolean
  onBrush: (v: number) => void
  onLevel: (v: number) => void
  onUndo: () => void
  onRedo: () => void
  onDone: () => void
}) {
  return (
    <div className="px-3 sm:px-6 pb-3 sm:pb-6 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
      <div className="ctrl flex items-center gap-2 sm:gap-3 px-3 sm:px-4 h-9 sm:h-10">
        <span className="label">brush</span>
        <input
          type="range"
          min={8}
          max={96}
          value={brush}
          onChange={(e) => onBrush(Number(e.target.value))}
          className="w-20 sm:w-24"
          aria-label="Brush size"
        />
      </div>
      <div className="ctrl flex items-center gap-2 sm:gap-3 px-3 sm:px-4 h-9 sm:h-10">
        <span className="label">cells</span>
        <input
          type="range"
          min={1}
          max={10}
          value={level}
          onChange={(e) => onLevel(Number(e.target.value))}
          className="w-20 sm:w-24"
          aria-label="Mosaic cell size"
        />
      </div>
      <button
        type="button"
        className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
        onClick={onUndo}
        disabled={!canUndo}
      >
        undo
      </button>
      <button
        type="button"
        className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
        onClick={onRedo}
        disabled={!canRedo}
      >
        redo
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
  )
}

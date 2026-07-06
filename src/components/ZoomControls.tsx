'use client'

export default function ZoomControls({
  pct,
  onZoomOut,
  onZoomIn,
  onFit,
}: {
  pct: number
  onZoomOut: () => void
  onZoomIn: () => void
  onFit: () => void
}) {
  return (
    <div className="absolute bottom-3 right-3 flex items-center gap-1 select-none">
      <button
        type="button"
        aria-label="Zoom out"
        className="ctrl label w-8 h-8 flex items-center justify-center cursor-pointer"
        onClick={onZoomOut}
      >
        −
      </button>
      <button
        type="button"
        aria-label="Reset zoom to fit"
        className="ctrl label px-2 h-8 flex items-center justify-center cursor-pointer tabular-nums"
        onClick={onFit}
        style={{ minWidth: 56 }}
      >
        {pct}%
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        className="ctrl label w-8 h-8 flex items-center justify-center cursor-pointer"
        onClick={onZoomIn}
      >
        +
      </button>
    </div>
  )
}

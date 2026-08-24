'use client'

import { useEffect, useRef } from 'react'
import {
  GLITTER_SHAPES,
  drawGlitterItems,
  loadPlatesFor,
  type GlitterItem,
  type GlitterShape,
} from '@/lib/glitter'
import type { GlitterDraft } from '@/lib/useGlitterTool'

// Glitter-appropriate palette. Deliberately its own list rather than a
// constant shared with TextControls — caption colors and sparkle colors are
// not the same design problem.
// Glitter-appropriate palette, deliberately its own list rather than a
// constant shared with TextControls — caption colours and sparkle colours are
// not the same design problem. No black: a sparkle is screened onto the photo,
// and adding light cannot darken it.
const SWATCHES = ['#fff6e0', '#ffc65a', '#e8a33d', '#f2a7c3', '#9fd0e8', '#c9a7ff']

const ICON = 30

/** One palette button, rendered with the real shape renderer at a fixed
 *  rotation/seed so it never jitters between renders. */
function ShapeIcon({ shape }: { shape: GlitterShape }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    canvas.width = ICON * dpr
    canvas.height = ICON * dpr
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, ICON, ICON)
    const item: GlitterItem = {
      id: 0,
      shape,
      x: ICON / 2,
      y: ICON / 2,
      size: ICON - 6,
      color: '#ffe9c4',
      rotation: 0,
      seed: 7,
    }
    const draw = () => {
      ctx.clearRect(0, 0, ICON, ICON)
      drawGlitterItems(ctx, [item])
    }
    draw()
    // The photographic shapes have nothing to draw until their plate loads.
    let alive = true
    loadPlatesFor([item]).then(() => {
      if (alive) draw()
    })
    return () => {
      alive = false
    }
  }, [shape])
  return <canvas ref={ref} style={{ width: ICON, height: ICON }} aria-hidden />
}

/** Toolbar shown while the glitter tool is active. */
export default function GlitterControls({
  draft,
  selected,
  hasItems,
  maxSize,
  onDraftChange,
  onUndo,
  onDelete,
  onDone,
}: {
  draft: GlitterDraft
  selected: GlitterItem | null
  hasItems: boolean
  maxSize: number
  onDraftChange: (patch: Partial<GlitterDraft>) => void
  onUndo: () => void
  onDelete: () => void
  onDone: () => void
}) {
  // The controls show the selected sparkle's style when there is one, and the
  // next-tap default otherwise — they are the same edit either way.
  const shape = selected?.shape ?? draft.shape
  const color = selected?.color ?? draft.color
  const size = selected?.size ?? draft.size

  return (
    <div className="pb-3 sm:pb-6">
      {/* shape palette — its own scrollable row; ten targets never fit
          beside the color strip and the slider on a phone. */}
      <div className="px-3 sm:px-6 pb-1.5 sm:pb-2 flex justify-center">
        <div
          className="flex items-center gap-1 overflow-x-auto max-w-full py-0.5"
          style={{ scrollSnapType: 'x mandatory' }}
          role="radiogroup"
          aria-label="Sparkle shape"
        >
          {GLITTER_SHAPES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={shape === s}
              aria-label={s}
              onClick={() => onDraftChange({ shape: s })}
              className="ctrl shrink-0 flex items-center justify-center w-10 h-10 cursor-pointer"
              data-active={shape === s}
              style={{ scrollSnapAlign: 'center' }}
            >
              <ShapeIcon shape={s} />
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 sm:px-6 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
        <div className="ctrl flex items-center gap-2 sm:gap-3 px-3 sm:px-4 h-9 sm:h-10">
          <span className="label">size</span>
          <input
            type="range"
            min={12}
            max={maxSize}
            value={size}
            onChange={(e) => onDraftChange({ size: Number(e.target.value) })}
            className="w-20 sm:w-24"
            aria-label="Sparkle size"
          />
        </div>
        <div className="ctrl flex items-center gap-1.5 px-3 h-9 sm:h-10">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onDraftChange({ color: c })}
              className="w-4 h-4 rounded-full cursor-pointer"
              style={{
                background: c,
                outline: color === c ? '2px solid var(--amber)' : '1px solid var(--line-strong)',
                outlineOffset: 1,
              }}
              aria-label={`Color ${c}`}
            />
          ))}
          <input
            type="color"
            value={color}
            onChange={(e) => onDraftChange({ color: e.target.value })}
            className="w-5 h-5 cursor-pointer bg-transparent border-0 p-0"
            aria-label="Custom color"
          />
        </div>
        <button
          type="button"
          className="ctrl label px-3 h-9 sm:h-10 cursor-pointer"
          onClick={onUndo}
          disabled={!hasItems}
        >
          undo
        </button>
        <button
          type="button"
          className="ctrl label px-3 h-9 sm:h-10 cursor-pointer"
          onClick={onDelete}
          disabled={!selected}
        >
          delete
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

'use client'

import { useEffect, useRef, useState } from 'react'
import type { Rect } from '@/lib/inpaint'

type Dims = { w: number; h: number }

// Selection rectangle in display (CSS) pixels.
type Sel = { x: number; y: number; w: number; h: number }

// A drag either moves the whole selection or resizes it from one edge/corner.
// ex/ey are the edge directions being dragged: -1 = left/top, 1 = right/bottom,
// 0 = that axis is fixed.
type DragMode =
  | { kind: 'move' }
  | { kind: 'resize'; ex: -1 | 0 | 1; ey: -1 | 0 | 1 }

// Boundaries are grabbed via large invisible hit areas so a fingertip can land
// them easily; the visible marks (corner squares, edge bars) stay small. Edge
// bands run the full length of each side, so you can drag anywhere on an edge,
// not just its midpoint.
const CORNER_HIT = 44 // px touch target centered on each corner
const EDGE_BAND = 26 // px thickness of the draggable band along each edge

const CORNERS: { ex: -1 | 1; ey: -1 | 1; cursor: string }[] = [
  { ex: -1, ey: -1, cursor: 'nwse-resize' },
  { ex: 1, ey: -1, cursor: 'nesw-resize' },
  { ex: -1, ey: 1, cursor: 'nesw-resize' },
  { ex: 1, ey: 1, cursor: 'nwse-resize' },
]

const EDGES: {
  ex: -1 | 0 | 1
  ey: -1 | 0 | 1
  cursor: string
  band: React.CSSProperties
  bar: React.CSSProperties
}[] = [
  { ex: 0, ey: -1, cursor: 'ns-resize', band: { left: EDGE_BAND, right: EDGE_BAND, top: -EDGE_BAND / 2, height: EDGE_BAND }, bar: { width: 22, height: 3 } },
  { ex: 0, ey: 1, cursor: 'ns-resize', band: { left: EDGE_BAND, right: EDGE_BAND, bottom: -EDGE_BAND / 2, height: EDGE_BAND }, bar: { width: 22, height: 3 } },
  { ex: -1, ey: 0, cursor: 'ew-resize', band: { top: EDGE_BAND, bottom: EDGE_BAND, left: -EDGE_BAND / 2, width: EDGE_BAND }, bar: { width: 3, height: 22 } },
  { ex: 1, ey: 0, cursor: 'ew-resize', band: { top: EDGE_BAND, bottom: EDGE_BAND, right: -EDGE_BAND / 2, width: EDGE_BAND }, bar: { width: 3, height: 22 } },
]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))

export default function CropOverlay({
  natural,
  display,
  onChange,
}: {
  natural: Dims
  display: Dims
  onChange: (rect: Rect) => void
}) {
  const [sel, setSel] = useState<Sel>({ x: 0, y: 0, w: display.w, h: display.h })
  const containerRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: DragMode; startX: number; startY: number; start: Sel } | null>(null)

  // Keep the latest onChange without making the report effect depend on its
  // identity (parent passes an inline arrow that writes a ref). Updated in an
  // effect — writing a ref during render is disallowed.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  // Minimum selection in display px, derived from 32 natural px on each axis.
  const minW = Math.min(display.w, 32 * (display.w / natural.w))
  const minH = Math.min(display.h, 32 * (display.h / natural.h))

  // If the display box changes size mid-crop (e.g. device rotation), rescale
  // the selection proportionally instead of snapping it away.
  const prevDisplay = useRef(display)
  useEffect(() => {
    const p = prevDisplay.current
    if (p.w > 0 && p.h > 0 && (p.w !== display.w || p.h !== display.h)) {
      const rx = display.w / p.w
      const ry = display.h / p.h
      setSel((s) => ({ x: s.x * rx, y: s.y * ry, w: s.w * rx, h: s.h * ry }))
    }
    prevDisplay.current = display
  }, [display])

  // Report the selection in natural image coordinates on mount and on change.
  useEffect(() => {
    const sx = natural.w / display.w
    const sy = natural.h / display.h
    const x = clamp(Math.round(sel.x * sx), 0, natural.w)
    const y = clamp(Math.round(sel.y * sy), 0, natural.h)
    const w = clamp(Math.round(sel.w * sx), 1, natural.w - x)
    const h = clamp(Math.round(sel.h * sy), 1, natural.h - y)
    onChangeRef.current({ x, y, w, h })
  }, [sel, natural, display])

  const beginDrag = (e: React.PointerEvent, mode: DragMode) => {
    e.stopPropagation()
    containerRef.current?.setPointerCapture(e.pointerId)
    drag.current = { mode, startX: e.clientX, startY: e.clientY, start: sel }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    const s = d.start
    if (d.mode.kind === 'move') {
      setSel({
        x: clamp(s.x + dx, 0, display.w - s.w),
        y: clamp(s.y + dy, 0, display.h - s.h),
        w: s.w,
        h: s.h,
      })
      return
    }
    const { ex, ey } = d.mode
    let { x, y, w, h } = s
    if (ex === -1) {
      const nx = clamp(s.x + dx, 0, s.x + s.w - minW)
      w = s.x + s.w - nx
      x = nx
    } else if (ex === 1) {
      w = clamp(s.w + dx, minW, display.w - s.x)
    }
    if (ey === -1) {
      const ny = clamp(s.y + dy, 0, s.y + s.h - minH)
      h = s.y + s.h - ny
      y = ny
    } else if (ey === 1) {
      h = clamp(s.h + dy, minH, display.h - s.y)
    }
    setSel({ x, y, w, h })
  }

  const endDrag = () => {
    drag.current = null
  }

  // The four dimmed strips outside the selection (no overflow/clipping tricks).
  const strips: React.CSSProperties[] = [
    { left: 0, top: 0, width: display.w, height: sel.y },
    { left: 0, top: sel.y + sel.h, width: display.w, height: display.h - sel.y - sel.h },
    { left: 0, top: sel.y, width: sel.x, height: sel.h },
    { left: sel.x + sel.w, top: sel.y, width: display.w - sel.x - sel.w, height: sel.h },
  ]

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 touch-none"
      style={{ width: display.w, height: display.h }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {strips.map((s, i) => (
        <div key={i} className="absolute pointer-events-none" style={{ ...s, background: 'rgba(0,0,0,0.6)' }} />
      ))}
      <div
        className="absolute"
        style={{
          left: sel.x,
          top: sel.y,
          width: sel.w,
          height: sel.h,
          border: '1px solid var(--amber)',
          cursor: 'move',
        }}
        onPointerDown={(e) => beginDrag(e, { kind: 'move' })}
      >
        {/* Edge bands: drag anywhere along a side. Rendered before corners so
            the corner hit areas win where they overlap. */}
        {EDGES.map((ed, i) => (
          <div
            key={`e${i}`}
            onPointerDown={(e) => beginDrag(e, { kind: 'resize', ex: ed.ex, ey: ed.ey })}
            style={{
              position: 'absolute',
              ...ed.band,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: ed.cursor,
              touchAction: 'none',
            }}
          >
            <span style={{ ...ed.bar, background: 'var(--amber)', borderRadius: 2 }} />
          </div>
        ))}
        {/* Corners: large touch target, small visible square. */}
        {CORNERS.map((cn, i) => (
          <div
            key={`c${i}`}
            onPointerDown={(e) => beginDrag(e, { kind: 'resize', ex: cn.ex, ey: cn.ey })}
            style={{
              position: 'absolute',
              left: `${((cn.ex + 1) / 2) * 100}%`,
              top: `${((cn.ey + 1) / 2) * 100}%`,
              width: CORNER_HIT,
              height: CORNER_HIT,
              transform: 'translate(-50%, -50%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: cn.cursor,
              touchAction: 'none',
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                background: 'var(--amber)',
                border: '2px solid #181612',
                borderRadius: 3,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

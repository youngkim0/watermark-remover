'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type Dims = { w: number; h: number }
type View = { zoom: number; panX: number; panY: number }

const MIN_ZOOM = 1
const MAX_ZOOM = 8
const STEP = 1.25

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))

export function useViewTransform({
  containerRef,
  fit,
  enabled,
  onPinchStart,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  fit: Dims
  enabled: boolean
  onPinchStart: () => void
}) {
  const view = useRef<View>({ zoom: 1, panX: 0, panY: 0 })
  const [zoomPct, setZoomPct] = useState(100)

  // Latest fit / enabled / callback via refs so the stable handlers below read
  // current values without re-binding. Synced in an effect (writing a ref during
  // render is disallowed); declared before the resize effect so its clamp reads
  // the fresh fit.
  const fitRef = useRef(fit)
  const enabledRef = useRef(enabled)
  const onPinchStartRef = useRef(onPinchStart)
  useEffect(() => {
    fitRef.current = fit
    enabledRef.current = enabled
    onPinchStartRef.current = onPinchStart
  })

  // Active touch points (id -> client pos), current pinch anchor, space-pan drag.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinch = useRef<{ dist: number; midX: number; midY: number } | null>(null)
  const spaceHeld = useRef(false)
  const panDrag = useRef<{ x: number; y: number } | null>(null)

  const clampPan = (v: View): View => {
    const f = fitRef.current
    return {
      zoom: v.zoom,
      panX: clamp(v.panX, -(f.w * (v.zoom - 1)), 0),
      panY: clamp(v.panY, -(f.h * (v.zoom - 1)), 0),
    }
  }

  const apply = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const v = view.current
    el.style.transformOrigin = '0 0'
    el.style.transform = `translate(${v.panX}px, ${v.panY}px) scale(${v.zoom})`
  }, [containerRef])

  const commit = useCallback(
    (next: View) => {
      view.current = clampPan(next)
      apply()
      const pct = Math.round(view.current.zoom * 100)
      setZoomPct((p) => (p === pct ? p : pct))
    },
    [apply]
  )

  const fitView = useCallback(() => {
    commit({ zoom: 1, panX: 0, panY: 0 })
  }, [commit])

  // Zoom by `factor` toward a screen focal point (defaults to frame center).
  const zoomTo = useCallback(
    (factor: number, focal?: { x: number; y: number }) => {
      const el = containerRef.current
      if (!el) return
      const v = view.current
      const zoom2 = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      if (zoom2 === v.zoom) return
      const rect = el.getBoundingClientRect()
      const f = fitRef.current
      const originX = rect.left - v.panX
      const originY = rect.top - v.panY
      const S = focal ?? {
        x: rect.left + (f.w * v.zoom) / 2,
        y: rect.top + (f.h * v.zoom) / 2,
      }
      const fx = (S.x - rect.left) / (f.w * v.zoom)
      const fy = (S.y - rect.top) / (f.h * v.zoom)
      commit({
        zoom: zoom2,
        panX: S.x - originX - fx * f.w * zoom2,
        panY: S.y - originY - fy * f.h * zoom2,
      })
    },
    [commit, containerRef]
  )

  const zoomIn = useCallback(() => zoomTo(STEP), [zoomTo])
  const zoomOut = useCallback(() => zoomTo(1 / STEP), [zoomTo])

  // Reset to fit whenever gestures get disabled (e.g. entering crop mode).
  useEffect(() => {
    if (!enabled) fitView()
  }, [enabled, fitView])

  // Re-apply + re-clamp when the fit box changes (window resize / rotation).
  useEffect(() => {
    commit(view.current)
  }, [fit, commit])

  // Native non-passive wheel: zoom toward the cursor.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!enabledRef.current) return
      e.preventDefault()
      zoomTo(Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [containerRef, zoomTo])

  // Space → pan-ready (desktop). Set base cursor imperatively so React re-renders
  // don't clobber the grab cursor mid-pan.
  useEffect(() => {
    const el = containerRef.current
    if (el) el.style.cursor = 'none'
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !enabledRef.current) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      spaceHeld.current = true
      if (el) el.style.cursor = 'grab'
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      spaceHeld.current = false
      panDrag.current = null
      if (el) el.style.cursor = 'none'
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [containerRef])

  const onPointerDown = (e: React.PointerEvent): boolean => {
    if (!enabledRef.current) return false
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (spaceHeld.current) {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      panDrag.current = { x: e.clientX, y: e.clientY }
      if (containerRef.current) containerRef.current.style.cursor = 'grabbing'
      return true
    }

    if (pointers.current.size === 2) {
      onPinchStartRef.current()
      const [a, b] = [...pointers.current.values()]
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      }
      return true
    }
    return false
  }

  const onPointerMove = (e: React.PointerEvent): boolean => {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    if (panDrag.current) {
      const dx = e.clientX - panDrag.current.x
      const dy = e.clientY - panDrag.current.y
      panDrag.current = { x: e.clientX, y: e.clientY }
      commit({ zoom: view.current.zoom, panX: view.current.panX + dx, panY: view.current.panY + dy })
      return true
    }

    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      const p = pinch.current
      const factor = p.dist ? dist / p.dist : 1
      // Pan by the midpoint delta first (applies transform), then zoom anchored
      // at the current midpoint (reads the fresh, consistent rect).
      commit({
        zoom: view.current.zoom,
        panX: view.current.panX + (midX - p.midX),
        panY: view.current.panY + (midY - p.midY),
      })
      pinch.current = { dist, midX, midY }
      zoomTo(factor, { x: midX, y: midY })
      return true
    }

    return panDrag.current !== null || pinch.current !== null
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) {
      panDrag.current = null
      if (spaceHeld.current && containerRef.current) containerRef.current.style.cursor = 'grab'
    }
  }

  return { zoomPct, zoomIn, zoomOut, fit: fitView, onPointerDown, onPointerMove, onPointerUp }
}

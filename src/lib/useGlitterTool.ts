'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  drawGlitterItems,
  loadPlatesFor,
  measureGlitterItem,
  randomRotation,
  randomSeed,
  type GlitterItem,
  type GlitterShape,
} from '@/lib/glitter'
import type { Rect } from '@/lib/inpaint'

type Dims = { w: number; h: number }

/** Style carried from one placement to the next: set gold-medium once, then
 *  every tap is one gesture. */
export type GlitterDraft = { shape: GlitterShape; color: string; size: number }

// Extra tappable margin around a sparkle's footprint, display px feel at 1x.
const HIT_PAD = 12

let nextId = 1

/** A sparkle at ~1/10 of the image width reads as decoration, not as a
 *  subject. Clamped so it stays sane on thumbnails and on 4K photos. */
function defaultSize(dims: Dims): number {
  return Math.min(Math.max(Math.round(dims.w / 10), 24), 400)
}

/**
 * State + interactions for the glitter overlay: items live in React state,
 * get drawn onto `canvasRef` (the same routine the exporter uses), and are
 * placed/selected/dragged via the pointer handlers (natural-pixel coords).
 */
export function useGlitterTool({
  canvasRef,
  dims,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>
  dims: Dims | null
}) {
  const [items, setItems] = useState<GlitterItem[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // size 0 means "not derived yet"; the effect below fills it in from the
  // first image's dimensions and then leaves the user's choice alone.
  const [draft, setDraft] = useState<GlitterDraft>({
    shape: 'spark',
    // A saturated gold rather than white: white light on a bright photo has
    // no contrast to work with, and a screen cannot draw brighter than white.
    // Gold reads on a pale sky and still looks like light on a dark frame.
    color: '#ffc65a',
    size: 0,
  })
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null)
  // Mirror of `items` for event-time reads (removeCovered) without making
  // every consumer callback depend on the array identity.
  const itemsRef = useRef<GlitterItem[]>(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  // Derive the default size once dims arrive, then leave the user's choice
  // alone. Adjusted during render (guarded by size === 0, so it settles
  // after one extra render) rather than in an effect — this is state
  // derived from a prop, not a side effect to synchronize.
  if (dims && draft.size === 0) {
    setDraft((d) => ({ ...d, size: defaultSize(dims) }))
  }

  // Redraw the overlay whenever items change, then again once any
  // photographic plates finish loading — a plate shape draws nothing until
  // its image is in memory, the same way a text item draws in a fallback
  // face until its font lands.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dims) return
    const ctx = canvas.getContext('2d')!
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      drawGlitterItems(ctx, items)
    }
    draw()
    if (items.length === 0) return
    let alive = true
    loadPlatesFor(items).then(() => {
      if (alive) draw()
    })
    return () => {
      alive = false
    }
  }, [items, dims, canvasRef])

  const toNatural = useCallback(
    (e: React.PointerEvent) => {
      const rect = canvasRef.current!.getBoundingClientRect()
      return {
        x: ((e.clientX - rect.left) / rect.width) * (dims?.w ?? 1),
        y: ((e.clientY - rect.top) / rect.height) * (dims?.h ?? 1),
      }
    },
    [canvasRef, dims]
  )

  /** Tap an existing sparkle to select and drag it; tap anywhere else to
   *  place a new one there and drag it in the same gesture. Returns true —
   *  in this tool every tap on the image is ours. */
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!dims) return false
      const p = toNatural(e)
      for (let i = items.length - 1; i >= 0; i--) {
        const b = measureGlitterItem(items[i])
        if (
          p.x >= b.x - HIT_PAD && p.x <= b.x + b.w + HIT_PAD &&
          p.y >= b.y - HIT_PAD && p.y <= b.y + b.h + HIT_PAD
        ) {
          const hit = items[i]
          setSelectedId(hit.id)
          // The toolbar always displays the selected sparkle's style, so the
          // draft must adopt it here — otherwise the next tap (which places
          // from the draft) can silently disagree with what's on screen.
          setDraft((d) => ({ ...d, shape: hit.shape, color: hit.color, size: hit.size }))
          dragRef.current = { id: hit.id, dx: hit.x - p.x, dy: hit.y - p.y }
          e.currentTarget.setPointerCapture(e.pointerId)
          return true
        }
      }
      const item: GlitterItem = {
        id: nextId++,
        shape: draft.shape,
        x: p.x,
        y: p.y,
        size: draft.size || defaultSize(dims),
        color: draft.color,
        rotation: randomRotation(draft.shape),
        seed: randomSeed(),
      }
      setItems((list) => [...list, item])
      setSelectedId(item.id)
      dragRef.current = { id: item.id, dx: 0, dy: 0 }
      e.currentTarget.setPointerCapture(e.pointerId)
      return true
    },
    [items, dims, draft, toNatural]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag || !dims) return
      const p = toNatural(e)
      const x = Math.min(Math.max(p.x + drag.dx, 0), dims.w)
      const y = Math.min(Math.max(p.y + drag.dy, 0), dims.h)
      setItems((list) => list.map((it) => (it.id === drag.id ? { ...it, x, y } : it)))
    },
    [dims, toNatural]
  )

  const onPointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  const updateSelected = useCallback(
    (patch: Partial<GlitterItem>) => {
      setItems((list) => list.map((it) => (it.id === selectedId ? { ...it, ...patch } : it)))
    },
    [selectedId]
  )

  /** Toolbar edits: restyle the selected sparkle and carry the choice to the
   *  next tap. With nothing selected they only set the default. */
  const setDraftValue = useCallback(
    (patch: Partial<GlitterDraft>) => {
      setDraft((d) => ({ ...d, ...patch }))
      setItems((list) => list.map((it) => (it.id === selectedId ? { ...it, ...patch } : it)))
    },
    [selectedId]
  )

  /** Remove the most recently placed sparkle. Tap-to-place makes a stray tap
   *  easy, and this is the only mistake worth a dedicated undo. */
  const undoLast = useCallback(() => {
    setItems((list) => {
      if (list.length === 0) return list
      const last = list[list.length - 1]
      setSelectedId((sel) => (sel === last.id ? null : sel))
      return list.slice(0, -1)
    })
  }, [])

  const deleteSelected = useCallback(() => {
    setItems((list) => list.filter((it) => it.id !== selectedId))
    setSelectedId(null)
  }, [selectedId])

  const deselect = useCallback(() => setSelectedId(null), [])

  const reset = useCallback(() => {
    setItems([])
    setSelectedId(null)
    setDraft((d) => ({ ...d, size: 0 }))
    dragRef.current = null
  }, [])

  /** Shift anchors into the kept rect; drop items whose anchor is cut away. */
  const applyCrop = useCallback((rect: Rect) => {
    setSelectedId(null)
    setItems((list) =>
      list
        .filter(
          (it) =>
            it.x >= rect.x && it.x < rect.x + rect.w && it.y >= rect.y && it.y < rect.y + rect.h
        )
        .map((it) => ({ ...it, x: it.x - rect.x, y: it.y - rect.y }))
    )
  }, [])

  const restore = useCallback((list: GlitterItem[]) => {
    setItems(list)
    setSelectedId(null)
  }, [])

  /** Remove sparkles the erase strokes were aimed at, using the same rule the
   *  text tool uses: majority coverage of the footprint, or of the central
   *  core band a deliberate swipe crosses (a thin swipe over a big sparkle
   *  covers little area but obviously means "remove it").
   *  Returns the removed items so an undo can restore them. */
  const removeCovered = useCallback((rects: Rect[]) => {
    const overlap = (b: { x: number; y: number; w: number; h: number }, r: Rect) => {
      const ix = Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x)
      const iy = Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y)
      return ix > 0 && iy > 0 ? ix * iy : 0
    }
    const removed: GlitterItem[] = []
    const kept: GlitterItem[] = []
    for (const it of itemsRef.current) {
      const b = measureGlitterItem(it)
      const core = { x: b.x + b.w * 0.3, y: b.y + b.h * 0.3, w: b.w * 0.4, h: b.h * 0.4 }
      let cover = 0
      let coreCover = 0
      for (const r of rects) {
        cover += overlap(b, r)
        coreCover += overlap(core, r)
      }
      if (cover >= 0.5 * b.w * b.h || coreCover >= 0.5 * core.w * core.h) removed.push(it)
      else kept.push(it)
    }
    if (removed.length > 0) {
      setItems(kept)
      setSelectedId(null)
    }
    return removed
  }, [])

  /** Re-add items removed by an erase (undo). */
  const addBack = useCallback((list: GlitterItem[]) => {
    if (list.length > 0) setItems((prev) => [...prev, ...list])
  }, [])

  const selected = items.find((it) => it.id === selectedId) ?? null

  return {
    items,
    selected,
    draft,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    updateSelected,
    setDraftValue,
    undoLast,
    deleteSelected,
    deselect,
    reset,
    applyCrop,
    restore,
    removeCovered,
    addBack,
  }
}

'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { drawTextItems, loadFontsFor, measureTextItem, type TextItem } from '@/lib/text'
import type { Rect } from '@/lib/inpaint'

type Dims = { w: number; h: number }

// Extra tappable margin around an item's glyph bbox, display px feel at 1x.
const HIT_PAD = 12

let nextId = 1

/**
 * State + interactions for the text overlay: items live in React state, get
 * drawn onto `canvasRef` (the same routine the exporter uses), and are
 * selected/dragged via the pointer handlers (natural-pixel coordinates).
 */
export function useTextTool({
  canvasRef,
  dims,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>
  dims: Dims | null
}) {
  const [items, setItems] = useState<TextItem[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // Bumped when async font loads land, so selection chrome re-measures.
  const [fontEpoch, setFontEpoch] = useState(0)
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null)

  // Redraw the overlay whenever items change; redraw again once the fonts
  // (lazy, unicode-range sliced) finish loading.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dims) return
    const ctx = canvas.getContext('2d')!
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      drawTextItems(ctx, items)
    }
    draw()
    if (items.length === 0) return
    let alive = true
    loadFontsFor(items).then(() => {
      if (!alive) return
      draw()
      setFontEpoch((n) => n + 1)
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

  /** Returns true when the event hit an item (selected and drag-armed). */
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const p = toNatural(e)
      for (let i = items.length - 1; i >= 0; i--) {
        const b = measureTextItem(items[i])
        if (
          p.x >= b.x - HIT_PAD && p.x <= b.x + b.w + HIT_PAD &&
          p.y >= b.y - HIT_PAD && p.y <= b.y + b.h + HIT_PAD
        ) {
          setSelectedId(items[i].id)
          dragRef.current = { id: items[i].id, dx: items[i].x - p.x, dy: items[i].y - p.y }
          e.currentTarget.setPointerCapture(e.pointerId)
          return true
        }
      }
      setSelectedId(null)
      return false
    },
    [items, toNatural]
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

  const addItem = useCallback(() => {
    if (!dims) return
    const item: TextItem = {
      id: nextId++,
      text: 'Your text',
      x: dims.w / 2,
      y: dims.h / 2,
      size: Math.min(Math.max(Math.round(dims.w / 12), 24), 200),
      fontId: 'sans',
      weight: 700,
      color: '#ffffff',
    }
    setItems((list) => [...list, item])
    setSelectedId(item.id)
  }, [dims])

  const updateSelected = useCallback(
    (patch: Partial<TextItem>) => {
      setItems((list) => list.map((it) => (it.id === selectedId ? { ...it, ...patch } : it)))
    },
    [selectedId]
  )

  const deleteSelected = useCallback(() => {
    setItems((list) => list.filter((it) => it.id !== selectedId))
    setSelectedId(null)
  }, [selectedId])

  const deselect = useCallback(() => setSelectedId(null), [])

  const reset = useCallback(() => {
    setItems([])
    setSelectedId(null)
    dragRef.current = null
  }, [])

  /** Shift anchors into the kept rect; drop items whose anchor is cut away. */
  const applyCrop = useCallback((rect: Rect) => {
    setSelectedId(null)
    setItems((list) =>
      list
        .filter((it) => it.x >= rect.x && it.x < rect.x + rect.w && it.y >= rect.y && it.y < rect.y + rect.h)
        .map((it) => ({ ...it, x: it.x - rect.x, y: it.y - rect.y }))
    )
  }, [])

  const restore = useCallback((list: TextItem[]) => {
    setItems(list)
    setSelectedId(null)
  }, [])

  const selected = items.find((it) => it.id === selectedId) ?? null

  return {
    items,
    selected,
    fontEpoch,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    addItem,
    updateSelected,
    deleteSelected,
    deselect,
    reset,
    applyCrop,
    restore,
  }
}

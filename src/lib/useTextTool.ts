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
  // Item being edited inline (contentEditable caret on the image).
  const [editingId, setEditingId] = useState<number | null>(null)
  // Bumped when async font loads land, so selection chrome re-measures.
  const [fontEpoch, setFontEpoch] = useState(0)
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null)
  const lastTapRef = useRef<{ id: number; t: number } | null>(null)
  // Mirror of `items` for event-time reads (removeCovered) without making
  // every consumer callback depend on the array identity.
  const itemsRef = useRef<TextItem[]>(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  // Redraw the overlay whenever items change; redraw again once the fonts
  // (lazy, unicode-range sliced) finish loading. The item being edited is
  // skipped — its live DOM editor renders instead.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dims) return
    const ctx = canvas.getContext('2d')!
    const visible = items.filter((it) => it.id !== editingId)
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      drawTextItems(ctx, visible)
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
  }, [items, editingId, dims, canvasRef])

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

  /** Returns true when the event hit an item (selected and drag-armed).
   *  A second tap on the already-tapped item within 400ms opens the inline
   *  editor (works for both double-click and mobile double-tap). */
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const p = toNatural(e)
      for (let i = items.length - 1; i >= 0; i--) {
        const b = measureTextItem(items[i])
        if (
          p.x >= b.x - HIT_PAD && p.x <= b.x + b.w + HIT_PAD &&
          p.y >= b.y - HIT_PAD && p.y <= b.y + b.h + HIT_PAD
        ) {
          const id = items[i].id
          const now = performance.now()
          const last = lastTapRef.current
          lastTapRef.current = { id, t: now }
          setSelectedId(id)
          // Suppress the compatibility mousedown: its default action moves
          // focus to <body>, which would instantly blur (and close) the
          // inline editor this tap just opened.
          e.preventDefault()
          if (last && last.id === id && now - last.t < 400) {
            setEditingId(id)
            return true
          }
          dragRef.current = { id, dx: items[i].x - p.x, dy: items[i].y - p.y }
          e.currentTarget.setPointerCapture(e.pointerId)
          return true
        }
      }
      lastTapRef.current = null
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
    // Open the inline editor immediately — typing replaces the placeholder.
    setEditingId(item.id)
  }, [dims])

  const startEditing = useCallback((id: number) => {
    setSelectedId(id)
    setEditingId(id)
  }, [])

  /** End the inline edit: apply the typed text, drop the item if emptied.
   *  Safe to call when no edit is active (idempotent). */
  const commitEditing = useCallback(
    (text: string) => {
      if (editingId == null) return
      const id = editingId
      setEditingId(null)
      if (text.trim() === '') {
        setItems((list) => list.filter((it) => it.id !== id))
        setSelectedId((sel) => (sel === id ? null : sel))
      } else {
        setItems((list) => list.map((it) => (it.id === id ? { ...it, text } : it)))
      }
    },
    [editingId]
  )

  /** Remove items whose bbox is majority-covered by the erased regions
   *  (users brush over their own text expecting the eraser to take it).
   *  Returns the removed items so an undo can restore them. */
  const removeCovered = useCallback((rects: Rect[]) => {
    const removed: TextItem[] = []
    const kept: TextItem[] = []
    for (const it of itemsRef.current) {
      const b = measureTextItem(it)
      let cover = 0
      for (const r of rects) {
        const ix = Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x)
        const iy = Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y)
        if (ix > 0 && iy > 0) cover += ix * iy
      }
      if (cover >= 0.5 * b.w * b.h) removed.push(it)
      else kept.push(it)
    }
    if (removed.length > 0) {
      setItems(kept)
      setSelectedId(null)
      setEditingId(null)
    }
    return removed
  }, [])

  /** Re-add items removed by an erase (undo). */
  const addBack = useCallback((restore: TextItem[]) => {
    if (restore.length > 0) setItems((list) => [...list, ...restore])
  }, [])

  const updateSelected = useCallback(
    (patch: Partial<TextItem>) => {
      setItems((list) => list.map((it) => (it.id === selectedId ? { ...it, ...patch } : it)))
    },
    [selectedId]
  )

  const deleteSelected = useCallback(() => {
    setItems((list) => list.filter((it) => it.id !== selectedId))
    setSelectedId(null)
    setEditingId(null)
  }, [selectedId])

  const deselect = useCallback(() => setSelectedId(null), [])

  const reset = useCallback(() => {
    setItems([])
    setSelectedId(null)
    setEditingId(null)
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
    setEditingId(null)
  }, [])

  const selected = items.find((it) => it.id === selectedId) ?? null
  const editing = items.find((it) => it.id === editingId) ?? null

  return {
    items,
    selected,
    editing,
    fontEpoch,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    addItem,
    startEditing,
    commitEditing,
    removeCovered,
    addBack,
    updateSelected,
    deleteSelected,
    deselect,
    reset,
    applyCrop,
    restore,
  }
}

# Glitter Stickers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third editor tool — `glitter` — that lets a user tap the photo to place decorative sparkles from a palette of ten canvas-drawn shapes, restyle and move them, and export them into the saved PNG.

**Architecture:** Sparkles are plain data (`GlitterItem[]`) held in a React hook and drawn onto a dedicated overlay canvas by the same routine that composites them into the exported PNG, so preview equals output. Nothing is ever baked into the working bitmap. Every piece mirrors the existing text tool (`src/lib/text.ts`, `src/lib/useTextTool.ts`, `src/components/TextControls.tsx`), which is the pattern this editor already follows.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, HTML canvas 2D. No new dependencies. No test runner in this repo.

**Spec:** `docs/superpowers/specs/2026-08-23-glitter-stickers-design.md`

## Global Constraints

- **No new dependencies.** Shapes are canvas paths; no SVG/PNG assets, no icon library, no emoji glyphs.
- **No blend modes.** Shapes draw source-over so the overlay canvas and the export path produce identical pixels for any color, including dark ones.
- **No `Math.random()` at draw time.** Multi-element shapes (`dust`) derive positions from `item.seed` through a seeded PRNG, so every redraw and the export are identical. Randomness happens once, at placement.
- **Never bake overlays into the working bitmap.** Sparkles composite only into the downloaded PNG, exactly as text does.
- **No full-frame `ImageData` retention.** This repo's standing mobile-memory rule: overlay work uses canvas-to-canvas draws, never `getImageData` over the whole image.
- **UI copy is lowercase** to match the existing toolbar (`brush`, `cut`, `text`, `undo`, `erase`, `save png`).
- **The tool button reads `glitter` with no ✦ glyph.** That glyph already means "the watermark we detect and remove" (`✦ detect`) and must not also mean "the sparkle you add".
- **Coordinates are natural pixels, center-anchored**, like `TextItem`.
- **Colors are 6-digit hex** (`#rrggbb`) — what both the swatches and `<input type="color">` produce.

## Verification model (read before Task 1)

This repo has **no test runner and no test files** — verification is a typecheck/lint/build gate plus a scripted manual pass in the browser. Every task ends with:

```bash
npx tsc --noEmit && npx eslint
```

Both must be clean (the repo's lint blocks ref writes during render and use-before-declare, so expect it to catch mistakes a typecheck won't). Tasks that change behavior also carry an explicit browser check with exact click-by-click steps and the exact expected observation. Run the app with:

```bash
npm run dev     # http://localhost:3000
```

and drop any image onto the dropzone to reach the editor.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/glitter.ts` | create (Task 1) | `GlitterItem` type, ten shape drawers, `drawGlitterItems`, `measureGlitterItem`, placement randomness helpers. Pure canvas — no React, no DOM beyond a 2D context. |
| `src/lib/useGlitterTool.ts` | create (Task 2) | Sparkle state and pointer interactions: place, hit-test, select, drag, sticky draft, undo-last, delete, crop-shift, restore, remove-covered. |
| `src/components/GlitterControls.tsx` | create (Task 3) | The two-row toolbar shown while the tool is active, including the ten-shape palette whose icons are drawn by `glitter.ts` itself. |
| `src/components/Editor.tsx` | modify (Tasks 2–6) | Wiring: tool mode, overlay canvas layer, pointer routing, status line, export, crop, erase interplay, analytics. |

---

### Task 1: The ten shapes (`src/lib/glitter.ts`)

**Files:**
- Create: `src/lib/glitter.ts`
- Temporary (created and deleted inside this task, never committed): `src/app/glitter-harness/page.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type GlitterShape = 'spark' | 'star' | 'twinkle' | 'burst' | 'dust' | 'bokeh' | 'ring' | 'diamond' | 'heart' | 'snowflake'`
  - `type GlitterItem = { id: number; shape: GlitterShape; x: number; y: number; size: number; color: string; rotation: number; seed: number }`
  - `const GLITTER_SHAPES: GlitterShape[]` — palette order
  - `function drawGlitterItems(ctx: CanvasRenderingContext2D, items: GlitterItem[]): void`
  - `function measureGlitterItem(item: GlitterItem): { x: number; y: number; w: number; h: number }`
  - `function randomRotation(shape: GlitterShape): number`
  - `function randomSeed(): number`

- [ ] **Step 1: Write `src/lib/glitter.ts`**

Every shape is authored in a **unit circle of radius 1**; `drawGlitterItems` translates to the anchor, rotates, and scales by `size / 2`, so a shape drawn out to radius 1 exactly fills its `size`-diameter footprint. Line widths are therefore also in unit terms (`0.09` means 9% of the radius).

```ts
// Glitter overlay items: decorative sparkles drawn onto a canvas with the same
// routine for the live preview and the exported PNG, so what you see is
// exactly what you save. Shapes are canvas paths (no assets), authored in a
// unit circle of radius 1 and scaled to the item's size at draw time.

export type GlitterShape =
  | 'spark'
  | 'star'
  | 'twinkle'
  | 'burst'
  | 'dust'
  | 'bokeh'
  | 'ring'
  | 'diamond'
  | 'heart'
  | 'snowflake'

export type GlitterItem = {
  id: number
  shape: GlitterShape
  x: number // natural px, center anchor
  y: number
  size: number // natural px, bounding diameter
  color: string // #rrggbb
  rotation: number // radians, randomized at placement
  seed: number // stable randomness for multi-element shapes
}

/** Palette order — also the order the toolbar strip renders. */
export const GLITTER_SHAPES: GlitterShape[] = [
  'spark',
  'star',
  'twinkle',
  'burst',
  'dust',
  'bokeh',
  'ring',
  'diamond',
  'heart',
  'snowflake',
]

const TAU = Math.PI * 2

/** mulberry32 — small, fast, deterministic. `dust` must scatter its specks
 *  identically on every redraw and in the export, so draw-time randomness is
 *  always seeded from the item, never from Math.random(). */
function rng(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** #rrggbb (or #rgb) → rgba() at the given alpha. */
function withAlpha(hex: string, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (h.length !== 6 || Number.isNaN(n)) return `rgba(255,255,255,${alpha})`
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/** The soft light bloom every shape sits on. Without it a flat fill reads as
 *  a pasted icon rather than as light. */
function halo(ctx: CanvasRenderingContext2D, color: string, alpha: number) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
  g.addColorStop(0, withAlpha(color, alpha))
  g.addColorStop(0.45, withAlpha(color, alpha * 0.45))
  g.addColorStop(1, withAlpha(color, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, 1, 0, TAU)
  ctx.fill()
}

/** A star whose edges pinch toward the center through `waist`. `radii` gives
 *  one radius per tip (evenly spaced from straight up), so a 4-tip star with
 *  two short tips becomes a lens-flare cross. */
function pinchedStar(ctx: CanvasRenderingContext2D, radii: number[], waist: number) {
  const n = radii.length
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * TAU
    const next = -Math.PI / 2 + ((i + 1) / n) * TAU
    const mid = (a + next) / 2
    const x = Math.cos(a) * radii[i]
    const y = Math.sin(a) * radii[i]
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
    const nx = Math.cos(next) * radii[(i + 1) % n]
    const ny = Math.sin(next) * radii[(i + 1) % n]
    ctx.quadraticCurveTo(Math.cos(mid) * waist, Math.sin(mid) * waist, nx, ny)
  }
  ctx.closePath()
  ctx.fill()
}

/** A straight-edged polygon star: `points` tips at radius 1 alternating with
 *  valleys at `inner`. */
function polygonStar(ctx: CanvasRenderingContext2D, points: number, inner: number) {
  ctx.beginPath()
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i / (points * 2)) * TAU
    const r = i % 2 === 0 ? 1 : inner
    const x = Math.cos(a) * r
    const y = Math.sin(a) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fill()
}

/** Crossed tapered spikes — a needle star. Unlike `pinchedStar`, whose waist
 *  is dominated by its endpoints, each spike is its own slim shape, so the
 *  star stays fine however many spikes it has. */
function needleStar(ctx: CanvasRenderingContext2D, spikes: number, halfWidth: number) {
  for (let i = 0; i < spikes; i++) {
    ctx.save()
    ctx.rotate((i / spikes) * Math.PI)
    ctx.beginPath()
    ctx.moveTo(0, -1)
    ctx.quadraticCurveTo(halfWidth, 0, 0, 1)
    ctx.quadraticCurveTo(-halfWidth, 0, 0, -1)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
}

type Draw = (ctx: CanvasRenderingContext2D, item: GlitterItem) => void

const SHAPES: Record<GlitterShape, Draw> = {
  // 1. ✦ classic four-point sparkle.
  spark: (ctx, item) => {
    halo(ctx, item.color, 0.3)
    ctx.fillStyle = item.color
    pinchedStar(ctx, [1, 1, 1, 1], 0.18)
  },

  // 2. ★ five-point star, straight edges.
  star: (ctx, item) => {
    halo(ctx, item.color, 0.26)
    ctx.fillStyle = item.color
    polygonStar(ctx, 5, 0.42)
  },

  // 3. ✳ fine six-point needle star.
  twinkle: (ctx, item) => {
    halo(ctx, item.color, 0.28)
    ctx.fillStyle = item.color
    needleStar(ctx, 3, 0.18)
  },

  // 4. Lens-flare cross: long vertical rays, short horizontal, bright core.
  burst: (ctx, item) => {
    halo(ctx, item.color, 0.35)
    ctx.fillStyle = item.color
    pinchedStar(ctx, [1, 0.5, 1, 0.5], 0.06)
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.24)
    core.addColorStop(0, 'rgba(255,255,255,0.95)')
    core.addColorStop(1, withAlpha(item.color, 0))
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.arc(0, 0, 0.24, 0, TAU)
    ctx.fill()
  },

  // 5. Scattered glitter specks — positions fixed by the item's seed.
  dust: (ctx, item) => {
    halo(ctx, item.color, 0.16)
    const rand = rng(item.seed)
    for (let i = 0; i < 9; i++) {
      const a = rand() * TAU
      const r = 0.15 + rand() * 0.7
      const dot = 0.05 + rand() * 0.07
      ctx.fillStyle = withAlpha(item.color, 0.5 + rand() * 0.5)
      ctx.beginPath()
      ctx.arc(Math.cos(a) * r, Math.sin(a) * r, dot, 0, TAU)
      ctx.fill()
    }
    for (let i = 0; i < 2; i++) {
      const a = rand() * TAU
      const r = rand() * 0.5
      ctx.save()
      ctx.translate(Math.cos(a) * r, Math.sin(a) * r)
      ctx.rotate(rand() * TAU)
      ctx.scale(0.32, 0.32)
      ctx.fillStyle = item.color
      pinchedStar(ctx, [1, 1, 1, 1], 0.18)
      ctx.restore()
    }
  },

  // 6. Soft out-of-focus light orb. One gradient brightening toward the rim
  // and fading to nothing at the edge — a flat disc plus a stroked rim reads
  // as an opaque coin, not as light.
  bokeh: (ctx, item) => {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
    g.addColorStop(0, withAlpha(item.color, 0.16))
    g.addColorStop(0.82, withAlpha(item.color, 0.28))
    g.addColorStop(0.92, withAlpha(item.color, 0.5))
    g.addColorStop(1, withAlpha(item.color, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, 1, 0, TAU)
    ctx.fill()
  },

  // 7. Thin halo ring, alpha falling off around the sweep.
  ring: (ctx, item) => {
    halo(ctx, item.color, 0.14)
    const g = ctx.createLinearGradient(-1, -1, 1, 1)
    g.addColorStop(0, withAlpha(item.color, 0.95))
    g.addColorStop(1, withAlpha(item.color, 0.15))
    ctx.strokeStyle = g
    ctx.lineWidth = 0.07
    ctx.beginPath()
    ctx.arc(0, 0, 0.8, 0, TAU)
    ctx.stroke()
  },

  // 8. Gem: rhombus with a lighter facet.
  diamond: (ctx, item) => {
    halo(ctx, item.color, 0.24)
    ctx.fillStyle = item.color
    ctx.beginPath()
    ctx.moveTo(0, -1)
    ctx.lineTo(0.62, 0)
    ctx.lineTo(0, 1)
    ctx.lineTo(-0.62, 0)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.beginPath()
    ctx.moveTo(0, -1)
    ctx.lineTo(0.62, 0)
    ctx.lineTo(0, -0.1)
    ctx.closePath()
    ctx.fill()
  },

  // 9. Glossy heart.
  heart: (ctx, item) => {
    halo(ctx, item.color, 0.24)
    ctx.fillStyle = item.color
    ctx.beginPath()
    ctx.moveTo(0, 0.92)
    ctx.bezierCurveTo(-1.05, 0.08, -0.58, -0.98, 0, -0.34)
    ctx.bezierCurveTo(0.58, -0.98, 1.05, 0.08, 0, 0.92)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.beginPath()
    ctx.ellipse(-0.34, -0.3, 0.16, 0.1, -0.6, 0, TAU)
    ctx.fill()
  },

  // 10. ❄ six-arm crystal.
  snowflake: (ctx, item) => {
    halo(ctx, item.color, 0.2)
    ctx.strokeStyle = item.color
    ctx.lineWidth = 0.09
    ctx.lineCap = 'round'
    for (let i = 0; i < 6; i++) {
      ctx.save()
      ctx.rotate((i / 6) * TAU)
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(0, -0.95)
      ctx.stroke()
      for (const [at, len] of [
        [0.42, 0.24],
        [0.68, 0.17],
      ] as const) {
        ctx.beginPath()
        ctx.moveTo(0, -at)
        ctx.lineTo(Math.sin(0.6) * len, -at - Math.cos(0.6) * len)
        ctx.moveTo(0, -at)
        ctx.lineTo(-Math.sin(0.6) * len, -at - Math.cos(0.6) * len)
        ctx.stroke()
      }
      ctx.restore()
    }
  },
}

export function drawGlitterItems(ctx: CanvasRenderingContext2D, items: GlitterItem[]) {
  for (const item of items) {
    const r = item.size / 2
    if (r <= 0) continue
    ctx.save()
    ctx.translate(item.x, item.y)
    ctx.rotate(item.rotation)
    ctx.scale(r, r)
    SHAPES[item.shape](ctx, item)
    ctx.restore()
  }
}

/** Bounding box (natural px) for hit-testing, selection chrome and erase
 *  coverage. Rotation-invariant: every shape is drawn inside its inscribed
 *  circle, so the footprint is always the size-square around the anchor. */
export function measureGlitterItem(item: GlitterItem): {
  x: number
  y: number
  w: number
  h: number
} {
  return { x: item.x - item.size / 2, y: item.y - item.size / 2, w: item.size, h: item.size }
}

/** How far a shape may rotate at placement. A shape with a canonical "up"
 *  gets a small tilt; the rest take a full turn so a cluster never looks
 *  stamped. The symmetric shapes cost nothing to rotate freely — a 5-point
 *  star's full turn is visually ±36°, a 6-arm snowflake's ±30°, and dust,
 *  bokeh and ring look identical at any angle. A heart does not: it has no
 *  rotational symmetry, so a full turn lands it upside down. */
const ROTATION_JITTER: Record<GlitterShape, number> = {
  spark: Math.PI,
  star: Math.PI,
  twinkle: Math.PI,
  burst: Math.PI,
  dust: Math.PI,
  bokeh: Math.PI,
  ring: Math.PI,
  snowflake: Math.PI,
  diamond: 0.26, // ~15° — 2-fold symmetry, so a full turn tips it over
  heart: 0.17, // ~10° — a slight tilt is charming, sideways is broken
}

/** Placement-time randomness, bounded per shape. */
export function randomRotation(shape: GlitterShape): number {
  return (Math.random() * 2 - 1) * ROTATION_JITTER[shape]
}

export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint`
Expected: both clean, no output.

- [ ] **Step 3: Create a throwaway visual harness**

This page exists only to look at the ten shapes; it is deleted in Step 6 and never committed.

Create `src/app/glitter-harness/page.tsx`:

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { GLITTER_SHAPES, drawGlitterItems, type GlitterItem } from '@/lib/glitter'

export default function GlitterHarness() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current!
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#2a2f45'
    ctx.fillRect(0, 0, c.width, c.height)
    GLITTER_SHAPES.forEach((shape, i) => {
      const item: GlitterItem = {
        id: i,
        shape,
        x: 90 + (i % 5) * 160,
        y: 100 + Math.floor(i / 5) * 180,
        size: 120,
        color: i % 2 === 0 ? '#ffffff' : '#e8a33d',
        rotation: 0,
        seed: 12345 + i,
      }
      drawGlitterItems(ctx, [item])
      ctx.fillStyle = '#ece8df'
      ctx.font = '13px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(shape, item.x, item.y + 78)
    })
  }, [])
  return <canvas ref={ref} width={860} height={400} style={{ margin: 24 }} />
}
```

- [ ] **Step 4: Look at all ten shapes**

Run: `npm run dev`, then open `http://localhost:3000/glitter-harness`.

Expected: ten labelled marks on a blue-grey field. Check each one:
- `spark` — four points with concave, pinched edges (not a diamond).
- `star` — a clean five-point star, point up.
- `twinkle` — six thin needles.
- `burst` — a cross with long vertical rays, short horizontal, white-hot center.
- `dust` — a loose scatter of small dots plus two tiny sparkles, all inside the footprint.
- `bokeh` — a soft orb of light, brightest just inside the rim, edge fading to nothing (no hard outline).
- `ring` — a thin circle, bright on one side, faint on the other.
- `diamond` — a gem with a lighter top-right facet.
- `heart` — a heart with a small highlight, fully inside the footprint.
- `snowflake` — six arms with two branch pairs each.

Every shape must sit **inside** its 120px footprint (nothing clipped at the canvas edges, nothing overlapping its neighbor's label). Reload twice: `dust` must land in the *same* spots every time — that proves the seeded PRNG works. If a shape looks wrong, fix its drawer in `src/lib/glitter.ts` and reload.

- [ ] **Step 5: Delete the harness**

```bash
rm -rf src/app/glitter-harness
```

- [ ] **Step 6: Commit the library only**

```bash
git add src/lib/glitter.ts
git commit -m "Add glitter shape library: ten canvas-drawn sparkles"
```

Verify nothing else was staged: `git status --short` must show a clean tree.

---

### Task 2: Placement, dragging, and the tool mode

**Files:**
- Create: `src/lib/useGlitterTool.ts`
- Modify: `src/components/Editor.tsx`

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `useGlitterTool({ canvasRef, dims })` returning
  `{ items, selected, draft, onPointerDown, onPointerMove, onPointerUp, updateSelected, setDraftValue, undoLast, deleteSelected, deselect, reset, applyCrop, restore, removeCovered, addBack }`
  with:
  - `items: GlitterItem[]`, `selected: GlitterItem | null`, `draft: { shape: GlitterShape; color: string; size: number }`
  - `onPointerDown(e: React.PointerEvent): boolean` — true when the event was consumed
  - `updateSelected(patch: Partial<GlitterItem>): void`
  - `setDraftValue(patch: Partial<{ shape: GlitterShape; color: string; size: number }>): void` — updates the draft *and* the selected item
  - `undoLast(): void`, `deleteSelected(): void`, `deselect(): void`, `reset(): void`
  - `applyCrop(rect: Rect): void`, `restore(list: GlitterItem[]): void`
  - `removeCovered(rects: Rect[]): GlitterItem[]`, `addBack(list: GlitterItem[]): void`

- [ ] **Step 1: Write `src/lib/useGlitterTool.ts`**

```ts
'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  drawGlitterItems,
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
    color: '#ffffff',
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
  // alone. Adjusted during render (guarded by size === 0, so it settles after
  // one extra render) rather than in an effect — this is state derived from a
  // prop, not a side effect to synchronize, and this repo's
  // react-hooks/set-state-in-effect rule rejects the effect form outright.
  if (dims && draft.size === 0) {
    setDraft((d) => ({ ...d, size: defaultSize(dims) }))
  }

  // Redraw the overlay whenever items change. Cheap: a few dozen paths.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dims) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    drawGlitterItems(ctx, items)
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
          setSelectedId(items[i].id)
          dragRef.current = { id: items[i].id, dx: items[i].x - p.x, dy: items[i].y - p.y }
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
```

- [ ] **Step 2: Add the canvas ref, tool mode and hook to `Editor.tsx`**

In the import block at the top, after the `useTextTool` import, add:

```ts
import { useGlitterTool } from '@/lib/useGlitterTool'
import { measureGlitterItem } from '@/lib/glitter'
```

Import only what this task uses — the repo's lint fails on unused imports, and
`drawGlitterItems` / `GlitterItem` arrive in Tasks 4 and 5.

At `src/components/Editor.tsx:142` (after `const textCanvasRef = ...`) add:

```ts
  const glitterCanvasRef = useRef<HTMLCanvasElement>(null)
```

At `src/components/Editor.tsx:163`, widen the tool union:

```ts
  const [tool, setTool] = useState<'erase' | 'text' | 'glitter'>('erase')
```

At `src/components/Editor.tsx:168-169` (after the `textTool` lines) add:

```ts
  const glitterTool = useGlitterTool({ canvasRef: glitterCanvasRef, dims })
  const { reset: resetGlitter } = glitterTool
```

- [ ] **Step 3: Size and reset the glitter canvas with the others**

In the image-decode effect (`src/components/Editor.tsx:213`), add the new ref to the sizing loop:

```ts
        for (const ref of [imgCanvasRef, origCanvasRef, maskCanvasRef, textCanvasRef, glitterCanvasRef]) {
```

and next to `resetText()` (around line 226) add:

```ts
        resetText()
        resetGlitter()
```

Add `resetGlitter` to that effect's dependency array, which currently reads
`}, [file, resetText])` (around line 249) and becomes:

```ts
  }, [file, resetText, resetGlitter])
```

- [ ] **Step 4: Route pointer events to the tool**

In `onPointerDown` (`src/components/Editor.tsx:298`), after the existing `if (tool === 'text') { ... }` block, add:

```ts
    if (tool === 'glitter') {
      glitterTool.onPointerDown(e)
      return
    }
```

In `onPointerMove` (around line 328), after the existing `if (tool === 'text') { ... }` block, add:

```ts
    if (tool === 'glitter') {
      glitterTool.onPointerMove(e)
      return
    }
```

In `endStroke` (around line 346), add the glitter release beside the text one:

```ts
  const endStroke = () => {
    textTool.onPointerUp()
    glitterTool.onPointerUp()
    drawState.current.active = false
  }
```

- [ ] **Step 5: Render the overlay canvas and the selection ring**

In the stage markup, immediately after the text overlay canvas (`src/components/Editor.tsx:819`), add:

```tsx
          {/* glitter overlay — above text so a sparkle can sit on a caption,
              still under the compare plane so "original" hides it */}
          <canvas ref={glitterCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
```

After the existing text selection-ring block (the one ending around line 878), add:

```tsx
          {/* glitter selection ring — local space, so it tracks the sparkle
              through zoom/pan like the canvases do. */}
          {tool === 'glitter' && glitterTool.selected && dims && (() => {
            const b = measureGlitterItem(glitterTool.selected)
            return (
              <div
                aria-hidden
                className="absolute pointer-events-none border border-dashed rounded-full"
                style={{
                  left: b.x / displayScale - 4,
                  top: b.y / displayScale - 4,
                  width: b.w / displayScale + 8,
                  height: b.h / displayScale + 8,
                  borderColor: 'var(--amber-soft)',
                }}
              />
            )
          })()}
```

- [ ] **Step 6: Add enter/exit handlers and the ⌘Z binding**

After `exitText` (`src/components/Editor.tsx:625`) add:

```ts
  const enterGlitter = () => {
    if (busy || !dims || cropping) return
    setCursor(null)
    setTool('glitter')
    track('glitter-open')
  }

  const exitGlitter = () => {
    glitterTool.deselect()
    setTool('erase')
  }
```

In the keyboard effect (`src/components/Editor.tsx:745`), replace the early return

```ts
      if (tool !== 'erase') return
```

with

```ts
      if (tool === 'glitter') {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault()
          glitterTool.undoLast()
        }
        return
      }
      if (tool !== 'erase') return
```

(The effect already carries an `eslint-disable-next-line react-hooks/exhaustive-deps`, so no dependency change is needed.)

- [ ] **Step 7: Add the toolbar entry point and a placeholder tool toolbar**

In the erase toolbar, right after the `text` button (`src/components/Editor.tsx:1000-1006`), add:

```tsx
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={enterGlitter}
            disabled={busy}
          >
            glitter
          </button>
```

In the toolbar branch chain, add a `glitter` case between the `text` case and the final `else`. This placeholder is replaced wholesale by `GlitterControls` in Task 3 — it exists so this task is testable on its own:

```tsx
      ) : tool === 'glitter' ? (
        <div className="px-3 sm:px-6 pb-3 sm:pb-6 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
          <button
            type="button"
            className="ctrl label px-3 h-9 sm:h-10 cursor-pointer"
            onClick={glitterTool.undoLast}
            disabled={glitterTool.items.length === 0}
          >
            undo
          </button>
          <button
            type="button"
            className="ctrl label px-3 h-9 sm:h-10 cursor-pointer"
            onClick={glitterTool.deleteSelected}
            disabled={!glitterTool.selected}
          >
            delete
          </button>
          <button
            type="button"
            onClick={exitGlitter}
            className="label px-6 sm:px-7 h-9 sm:h-10 cursor-pointer"
            style={{ background: 'var(--amber)', color: '#181612', fontWeight: 500 }}
          >
            done
          </button>
        </div>
      ) : (
```

- [ ] **Step 8: Add the status line**

In the `status` expression (`src/components/Editor.tsx:775`), insert a glitter branch before the `tool === 'text'` branch:

```ts
  const status = cropping
    ? 'drag to select the area to keep'
    : tool === 'glitter'
    ? glitterTool.items.length === 0
      ? 'tap the image to add sparkle'
      : 'tap to add more — drag a sparkle to move it'
    : tool === 'text'
```

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint`
Expected: both clean.

- [ ] **Step 10: Browser check**

Run `npm run dev`, drop an image, then:

1. Press `glitter`. Status reads `tap the image to add sparkle`; the toolbar shows `undo` / `delete` / `done`.
2. Tap the photo five times in different places. Expected: five white four-point sparkles at the tap points, each rotated differently, the last one ringed by a dashed amber circle.
3. Press and drag one sparkle. Expected: it follows the pointer and stops at the image edges. It does **not** place a new one.
4. Tap an empty area. Expected: a sixth sparkle appears there and becomes the selected one.
5. Press `undo` twice. Expected: the two most recently placed sparkles disappear. Press ⌘Z (ctrl+Z on Windows). Expected: another one goes.
6. Select one and press `delete`. Expected: only that one goes.
7. Press and hold `compare`… the button is disabled until Task 4 wires `hasEdit`, so instead press `done`, then `new image` and re-drop the photo. Expected: no sparkles carry over.
8. Zoom in with the scroll wheel / pinch and drag a sparkle. Expected: the sparkle and its selection ring stay locked to the same spot on the photo.

- [ ] **Step 11: Commit**

```bash
git add src/lib/useGlitterTool.ts src/components/Editor.tsx
git commit -m "Add glitter tool: tap to place, drag to move"
```

---

### Task 3: The controls toolbar (`GlitterControls.tsx`)

**Files:**
- Create: `src/components/GlitterControls.tsx`
- Modify: `src/components/Editor.tsx` (replace the Task 2 placeholder toolbar)

**Interfaces:**
- Consumes: `GLITTER_SHAPES`, `drawGlitterItems`, `GlitterItem`, `GlitterShape` from `@/lib/glitter`; `GlitterDraft` from `@/lib/useGlitterTool`.
- Produces: default export `GlitterControls` with props
  `{ draft: GlitterDraft; selected: GlitterItem | null; hasItems: boolean; maxSize: number; onDraftChange: (patch: Partial<GlitterDraft>) => void; onUndo: () => void; onDelete: () => void; onDone: () => void }`

- [ ] **Step 1: Write `src/components/GlitterControls.tsx`**

The palette icons are drawn by `drawGlitterItems` itself — the palette is then a guaranteed preview of what a tap produces, and adding a shape never means also authoring an icon. Icons draw at a fixed rotation and a fixed seed so the strip is stable across re-renders.

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { GLITTER_SHAPES, drawGlitterItems, type GlitterItem, type GlitterShape } from '@/lib/glitter'
import type { GlitterDraft } from '@/lib/useGlitterTool'

// Glitter-appropriate palette. Deliberately its own list rather than a
// constant shared with TextControls — caption colors and sparkle colors are
// not the same design problem.
const SWATCHES = ['#ffffff', '#e8a33d', '#f2a7c3', '#9fd0e8', '#181612']

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
      color: '#ece8df',
      rotation: 0,
      seed: 7,
    }
    drawGlitterItems(ctx, [item])
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
```

- [ ] **Step 2: Swap the placeholder toolbar for the real one**

Add the import beside the other component imports in `Editor.tsx`:

```ts
import GlitterControls from './GlitterControls'
```

Replace the whole placeholder block added in Task 2 Step 7 (from `) : tool === 'glitter' ? (` through the `</div>` that closes it) with:

```tsx
      ) : tool === 'glitter' ? (
        <GlitterControls
          draft={glitterTool.draft}
          selected={glitterTool.selected}
          hasItems={glitterTool.items.length > 0}
          maxSize={dims ? Math.max(400, Math.round(dims.w / 3)) : 400}
          onDraftChange={glitterTool.setDraftValue}
          onUndo={glitterTool.undoLast}
          onDelete={glitterTool.deleteSelected}
          onDone={exitGlitter}
        />
```

The `maxSize` formula keeps the slider's ceiling useful on a 4K photo without making it useless on a small one.

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint`
Expected: both clean.

- [ ] **Step 4: Browser check**

Run `npm run dev`, drop an image, press `glitter`, then:

1. Expected: a scrollable strip of ten icons above the control row. Each icon is a small white rendering of its shape (compare against the Task 1 list); `spark` is ringed amber as the active one.
2. Tap `heart` in the strip, then tap the photo. Expected: a heart lands at the tap point.
3. Tap the pink swatch, drag `size` right, then tap the photo three times. Expected: three large pink hearts — the style stuck without needing to be re-set.
4. Select an existing sparkle (tap it), then tap `snowflake`. Expected: **that** sparkle becomes a snowflake, and the next tap on empty space also places a snowflake.
5. Drag the size slider with a sparkle selected. Expected: it resizes live from its center.
6. Use the custom color input. Expected: the selected sparkle re-tints.
7. Narrow the browser to 380px wide. Expected: two rows total, the shape strip scrolls horizontally, and no control is cut off or wraps into a third row.

- [ ] **Step 5: Commit**

```bash
git add src/components/GlitterControls.tsx src/components/Editor.tsx
git commit -m "Add glitter controls: ten-shape palette, color, size"
```

---

### Task 4: Export, `hasEdit`, and analytics

**Files:**
- Modify: `src/components/Editor.tsx` (`download`, `hasEdit`)

**Interfaces:**
- Consumes: `drawGlitterItems` from `@/lib/glitter`; `glitterTool.items`.
- Produces: nothing new; sparkles now reach the saved PNG.

- [ ] **Step 1: Import the draw routine**

Extend the glitter import in `Editor.tsx` (added in Task 2) to:

```ts
import { drawGlitterItems, measureGlitterItem } from '@/lib/glitter'
```

- [ ] **Step 2: Composite sparkles into the export**

Replace `download` (`src/components/Editor.tsx:706-732`) with:

```ts
  const download = async () => {
    track('download', {
      erases: eraseCount,
      texts: textTool.items.length,
      glitters: glitterTool.items.length,
    })
    const token = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('')
    let source: HTMLCanvasElement = imgCanvasRef.current!
    if (textTool.items.length > 0 || glitterTool.items.length > 0) {
      // Composite the overlays into the export (they never touch the working
      // canvas, so they stay editable after saving). Sparkles draw last so
      // they sit on top of a caption, matching the on-screen layering.
      await loadFontsFor(textTool.items)
      const scratch = document.createElement('canvas')
      scratch.width = source.width
      scratch.height = source.height
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(source, 0, 0)
      drawTextItems(ctx, textTool.items)
      drawGlitterItems(ctx, glitterTool.items)
      source = scratch
    }
    source.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Unmark_${token}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }
```

- [ ] **Step 3: Count sparkles as an edit**

Replace `hasEdit` (`src/components/Editor.tsx:770-775`) with:

```ts
  const hasEdit =
    eraseCount > 0 ||
    textTool.items.length > 0 ||
    glitterTool.items.length > 0 ||
    (dims !== null &&
      originalDims !== null &&
      (dims.w !== originalDims.w || dims.h !== originalDims.h))
```

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint`
Expected: both clean.

- [ ] **Step 5: Browser check**

Run `npm run dev`, drop an image, then:

1. Add four sparkles of different shapes and colors, then press `done`.
2. Expected: `save png` and `compare` are now enabled on an otherwise-untouched photo.
3. Hold `compare`. Expected: the sparkles disappear while held and come back on release.
4. Press `save png`, then open the downloaded `Unmark_*.png`.
5. Expected: the sparkles are in the file, at the same positions and the same *proportional* sizes as on screen, and crisp at full resolution — not upscaled from the on-screen preview. Zoom to 400% in a viewer and confirm the sparkle edges are clean.
6. Add a text caption, place a sparkle overlapping it, and save again. Expected: in the PNG the sparkle is drawn **over** the caption, matching the screen.

- [ ] **Step 6: Commit**

```bash
git add src/components/Editor.tsx
git commit -m "Composite glitter into the exported PNG"
```

---

### Task 5: Crop and crop-undo

**Files:**
- Modify: `src/components/Editor.tsx` (`CropUndo` type, `applyCrop`, the crop-undo branch of `undo`)

**Interfaces:**
- Consumes: `glitterTool.applyCrop`, `glitterTool.restore`, `glitterTool.items`.
- Produces: `CropUndo` gains `glitterItems: GlitterItem[]`.

- [ ] **Step 1: Import the item type**

The `CropUndo` type needs it. Extend the glitter import in `Editor.tsx` to:

```ts
import { drawGlitterItems, measureGlitterItem, type GlitterItem } from '@/lib/glitter'
```

- [ ] **Step 2: Carry sparkles in the crop-undo snapshot**

In the `CropUndo` type (`src/components/Editor.tsx:54-60`), add a field after `textItems`:

```ts
  textItems: TextItem[]
  glitterItems: GlitterItem[]
}
```

- [ ] **Step 3: Crop the sparkle layer**

In `applyCrop`, add the new field to the snapshot object (around line 667):

```ts
        textItems: textTool.items,
        glitterItems: glitterTool.items,
```

Resize the glitter canvas beside the text canvas (around line 693):

```ts
    textCanvasRef.current!.width = rect.w
    textCanvasRef.current!.height = rect.h
    glitterCanvasRef.current!.width = rect.w
    glitterCanvasRef.current!.height = rect.h
```

and shift the items beside the text ones (around line 698):

```ts
    textTool.applyCrop(rect)
    glitterTool.applyCrop(rect)
```

- [ ] **Step 4: Restore sparkles on crop-undo**

In the crop-undo branch of `undo` (around lines 477-481), resize and restore beside the text layer:

```ts
      textCanvasRef.current!.width = c.dims.w
      textCanvasRef.current!.height = c.dims.h
      glitterCanvasRef.current!.width = c.dims.w
      glitterCanvasRef.current!.height = c.dims.h
      maskStrokes.current = []
      eraseHistory.current = c.eraseHistory
      textTool.restore(c.textItems)
      glitterTool.restore(c.glitterItems)
```

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint`
Expected: both clean.

- [ ] **Step 6: Browser check**

Run `npm run dev`, drop an image, then:

1. Place a sparkle near the center and another near the top-left corner. Press `done`.
2. Press `cut`, drag a selection that covers the center sparkle but excludes the corner one, press `apply`.
3. Expected: the image crops; the center sparkle is still on the same part of the photo; the corner sparkle is gone.
4. Press `undo`.
5. Expected: the full image comes back **and both sparkles return**, both in their original spots.
6. Repeat with a very large image (≥12MP) where the crop-undo snapshot won't fit under the memory cap. Expected: crop still works, sparkles still shift correctly, and `undo` simply doesn't offer the crop back — no crash, no misplaced sparkles.

- [ ] **Step 7: Commit**

```bash
git add src/components/Editor.tsx
git commit -m "Keep glitter aligned through crop and crop-undo"
```

---

### Task 6: Brushing over a sparkle erases it

**Files:**
- Modify: `src/components/Editor.tsx` (`EraseUndo` type, new `dropOverlayStrokes` helper, `runErase`, `undo`)

**Interfaces:**
- Consumes: `glitterTool.removeCovered`, `glitterTool.addBack`, `measureGlitterItem`.
- Produces:
  - `EraseUndo` gains `glitters: GlitterItem[]`
  - `function dropOverlayStrokes(strokes: MaskStroke[], boxes: { x: number; y: number; w: number; h: number }[], d: Dims): MaskStroke[]`

**Why:** a sparkle was never part of the photo. If the eraser inpainted the pixels beneath it, it would smear untouched photo for no reason — the same bug fixed for text in commit `d7b59d8`. The logic exists inline in `runErase` for text only; this task lifts it out and runs both overlays through it rather than pasting it twice.

- [ ] **Step 1: Extend the undo entry type**

At `src/components/Editor.tsx:48` replace the `EraseUndo` type with:

```ts
// One entry per erase action; an action may inpaint several clusters (each
// contributing a patch) and swallow text or sparkles brushed over. Undo
// restores the whole entry: patches in reverse order, then the removed
// overlay items.
type EraseUndo = { patches: InpaintPatch[]; texts: TextItem[]; glitters: GlitterItem[] }
```

- [ ] **Step 2: Extract the stroke-dropping helper**

Add this module-level function next to `strokeRects` (after it, around line 88):

```ts
/** Drop the mask strokes that served to delete an overlay item, so the erase
 *  doesn't also inpaint the photo underneath it (that only smears untouched
 *  pixels — the item was never part of the image). A stroke goes when most of
 *  it lies over the removed items' footprints. */
function dropOverlayStrokes(
  strokes: MaskStroke[],
  boxes: { x: number; y: number; w: number; h: number }[],
  d: Dims
): MaskStroke[] {
  const margin = 12
  return strokes.filter((s) => {
    if (s.kind === 'detect') return true
    const [r] = strokeRects([s], d)
    if (!r) return false
    let cover = 0
    for (const b of boxes) {
      const ix = Math.min(r.x + r.w, b.x + b.w + margin) - Math.max(r.x, b.x - margin)
      const iy = Math.min(r.y + r.h, b.y + b.h + margin) - Math.max(r.y, b.y - margin)
      if (ix > 0 && iy > 0) cover += ix * iy
    }
    return cover < 0.7 * r.w * r.h
  })
}
```

- [ ] **Step 3: Run both overlays through it in `runErase`**

Replace the text-removal block in `runErase` (`src/components/Editor.tsx:511-532`, from the `// Overlay text goes first:` comment through the `if (maskStrokes.current.length !== before) replayMask(dims)` line) with:

```ts
      // Overlay items go first: brushing over your own text or sparkle means
      // "erase that", and since neither was ever part of the image, the photo
      // beneath must not be inpainted — that only smears untouched pixels.
      // Strokes that served to delete an overlay item are dropped entirely.
      const removedTexts = removeCoveredText(boxes0)
      const removedGlitters = removeCoveredGlitter(boxes0)
      if (removedTexts.length > 0 || removedGlitters.length > 0) {
        const overlayBoxes = [
          ...removedTexts.map((t) => measureTextItem(t)),
          ...removedGlitters.map((g) => measureGlitterItem(g)),
        ]
        const before = maskStrokes.current.length
        maskStrokes.current = dropOverlayStrokes(maskStrokes.current, overlayBoxes, dims)
        if (maskStrokes.current.length !== before) replayMask(dims)
      }
```

- [ ] **Step 4: Destructure the glitter remover and update the guards**

At `src/components/Editor.tsx:169`, extend the glitter destructure added in Task 2:

```ts
  const { reset: resetGlitter, removeCovered: removeCoveredGlitter } = glitterTool
```

In `runErase`, replace the three places that test only `removedTexts`:

```ts
      if (painted === 0 && removedTexts.length === 0 && removedGlitters.length === 0) return
```

```ts
      track('erase', {
        count: eraseCount + 1,
        clusters: clusters.length,
        texts: removedTexts.length,
        glitters: removedGlitters.length,
        ms: Math.round(performance.now() - t0),
      })
```

```ts
      if (patches.length > 0 || removedTexts.length > 0 || removedGlitters.length > 0) {
        eraseHistory.current.push({ patches, texts: removedTexts, glitters: removedGlitters })
```

and add `removeCoveredGlitter` to the `useCallback` dependency array at the end of `runErase`:

```ts
  }, [dims, eraseCount, onModelProgress, removeCoveredText, removeCoveredGlitter])
```

- [ ] **Step 5: Restore sparkles on erase-undo**

In the erase branch of `undo` (around line 460), add the glitter restore beside the text one:

```ts
      textTool.addBack(prev.texts)
      glitterTool.addBack(prev.glitters)
```

- [ ] **Step 6: Typecheck, lint, and build**

Run: `npx tsc --noEmit && npx eslint && npm run build`
Expected: all three clean. The build is included here because this is the last code task.

- [ ] **Step 7: Browser check**

Run `npm run dev`, drop an image, then:

1. Place a large sparkle over a flat area of the photo. Press `done`.
2. Brush a single swipe across the middle of the sparkle, then press `erase`.
3. Expected: the sparkle disappears **and the photo underneath is untouched** — no blur, no smear, no inpaint patch. Toggle `compare` to confirm the photo is byte-identical there.
4. Press `undo`. Expected: the sparkle comes back.
5. Now brush over a real watermark *and* a sparkle in one erase. Expected: the watermark is inpainted, the sparkle is removed, and the area under the sparkle is untouched. `undo` restores both.
6. Brush a stroke that merely grazes the edge of a sparkle and press `erase`. Expected: the sparkle **survives** (a graze is not intent) and the photo is inpainted normally.
7. Place a sparkle, brush over it, press `erase`, then press `new image` and re-drop. Expected: clean slate, no leftover state.

- [ ] **Step 8: Commit**

```bash
git add src/components/Editor.tsx
git commit -m "Erase removes brushed-over sparkles without inpainting beneath"
```

---

## Done criteria

All six tasks committed, and on a final pass through a fresh `npm run dev`:

- `npx tsc --noEmit`, `npx eslint`, `npm run build` all clean.
- All ten shapes place, render, and match their palette icons.
- Style is sticky across taps; editing a selected sparkle also sets the next-tap default.
- `undo` / ⌘Z removes the last placed sparkle; `delete` removes the selected one.
- Sparkles survive a crop when kept, vanish when cut away, and return on crop-undo.
- Brushing over a sparkle deletes it without inpainting the photo beneath; erase-undo restores it.
- `compare` hides sparkles; the exported PNG matches the preview at full resolution.
- On a 4K photo with ~30 sparkles, placing and dragging stays smooth on mobile Safari, and no full-frame `ImageData` is retained by the overlay path.

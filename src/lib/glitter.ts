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
    pinchedStar(ctx, [1, 1, 1, 1, 1, 1], 0.09)
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

  // 6. Soft out-of-focus light orb.
  bokeh: (ctx, item) => {
    ctx.fillStyle = withAlpha(item.color, 0.26)
    ctx.beginPath()
    ctx.arc(0, 0, 0.95, 0, TAU)
    ctx.fill()
    ctx.strokeStyle = withAlpha(item.color, 0.6)
    ctx.lineWidth = 0.12
    ctx.beginPath()
    ctx.arc(0, 0, 0.88, 0, TAU)
    ctx.stroke()
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

/** Placement-time randomness. A full turn: the symmetric shapes absorb it,
 *  and a cluster of sparkles never looks stamped. */
export function randomRotation(): number {
  return Math.random() * TAU
}

export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0
}

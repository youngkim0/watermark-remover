// The sparkle drawers. Every shape is authored in a unit circle of radius 1
// and drawn as light, not as paint: layers accumulate with 'lighter' inside
// the overlay canvas, and the overlay itself is screened onto the photo. That
// is what separates a sparkle from a sticker — the core blows out to white,
// the bloom carries the colour, and the photo shows through the falloff.
import { getPlate, plateAspect, type PlateId } from '@/lib/glitterPlates'
import type { GlitterItem, GlitterShape } from '@/lib/glitter'

const TAU = Math.PI * 2

/** mulberry32 — small, fast, deterministic. Every shape that varies must
 *  vary from `item.seed`, so a redraw and the export agree. */
export function rng(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** #rrggbb (or #rgb) → rgba() at the given alpha. */
export function withAlpha(hex: string, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(255,255,255,${alpha})`
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/** Nudge a colour toward warm or cool, for the chromatic split on ray tips. */
function shifted(hex: string, warm: number, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (h.length !== 6 || Number.isNaN(n)) return `rgba(255,255,255,${alpha})`
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  const r = clamp(((n >> 16) & 255) + warm * 60)
  const g = clamp((n >> 8) & 255)
  const b = clamp((n & 255) - warm * 60)
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * The soft bloom every sparkle sits in. Falls off steeply — a linear ramp
 * reads as a painted disc, an inverse-square-ish one reads as light.
 */
function bloom(ctx: CanvasRenderingContext2D, r: number, color: string, alpha: number) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
  g.addColorStop(0, withAlpha(color, alpha))
  g.addColorStop(0.08, withAlpha(color, alpha * 0.8))
  g.addColorStop(0.22, withAlpha(color, alpha * 0.38))
  g.addColorStop(0.5, withAlpha(color, alpha * 0.12))
  g.addColorStop(1, withAlpha(color, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, TAU)
  ctx.fill()
}

/** The hot centre. Small and white whatever the tint — a real specular
 *  highlight clips to white, and only its falloff is coloured. */
function core(ctx: CanvasRenderingContext2D, r: number, alpha = 1) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
  g.addColorStop(0, `rgba(255,255,255,${alpha})`)
  g.addColorStop(0.5, `rgba(255,255,255,${alpha * 0.5})`)
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, TAU)
  ctx.fill()
}

/**
 * One diffraction spike: a lens-shaped sliver from the centre out to `len`,
 * white at the base and fading to nothing at the tip.
 */
function spike(
  ctx: CanvasRenderingContext2D,
  angle: number,
  len: number,
  halfWidth: number,
  color: string,
  alpha: number
) {
  ctx.save()
  ctx.rotate(angle)
  const g = ctx.createLinearGradient(0, 0, len, 0)
  g.addColorStop(0, `rgba(255,255,255,${alpha})`)
  g.addColorStop(0.12, withAlpha(color, alpha * 0.85))
  g.addColorStop(0.5, withAlpha(color, alpha * 0.28))
  g.addColorStop(1, withAlpha(color, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.quadraticCurveTo(len * 0.22, -halfWidth, len, 0)
  ctx.quadraticCurveTo(len * 0.22, halfWidth, 0, 0)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** A spike drawn three times in split colours — the fringing that makes a
 *  highlight read as glass rather than as vinyl. */
function chromaticSpike(
  ctx: CanvasRenderingContext2D,
  angle: number,
  len: number,
  halfWidth: number,
  color: string,
  alpha: number
) {
  const split = len * 0.05
  ctx.save()
  ctx.rotate(angle)
  for (const [off, tint] of [
    [-split, shifted(color, 1, alpha * 0.5)],
    [split, shifted(color, -1, alpha * 0.5)],
  ] as const) {
    const g = ctx.createLinearGradient(off, 0, len + off, 0)
    g.addColorStop(0, withAlpha(color, 0))
    g.addColorStop(0.45, tint)
    g.addColorStop(1, withAlpha(color, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(off, 0)
    ctx.quadraticCurveTo(off + len * 0.22, -halfWidth, off + len, 0)
    ctx.quadraticCurveTo(off + len * 0.22, halfWidth, off, 0)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
  spike(ctx, angle, len, halfWidth, color, alpha)
}

/** A filled path shaded as light: tinted bloom behind, near-white body,
 *  bright rim. Used by the shapes that are objects rather than points. */
function luminousBody(
  ctx: CanvasRenderingContext2D,
  path: () => void,
  color: string,
  alpha: number
) {
  ctx.save()
  ctx.fillStyle = withAlpha(color, alpha * 0.55)
  path()
  ctx.fill()
  ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.85})`
  ctx.lineWidth = 0.05
  ctx.lineJoin = 'round'
  path()
  ctx.stroke()
  ctx.restore()
}

type Draw = (ctx: CanvasRenderingContext2D, item: GlitterItem, rand: () => number) => void

export type ShapeDef = {
  draw: Draw
  /** Mini copies scattered around the anchor, inside radius 1. A single
   *  symmetrical mark is the sticker tell; real glitter arrives in company. */
  satellites?: number
  /** How much of the footprint the anchor occupies when satellites are on. */
  anchor?: number
  /** Vertical squash of the shade beneath the sparkle. A round shade under a
   *  thin streak reads as a grey smudge, so the streaks flatten theirs. */
  shadeAspect?: number
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/** Four long spikes plus four short diagonals — the classic point of light. */
const drawSpark: Draw = (ctx, item, rand) => {
  bloom(ctx, 0.9, item.color, 0.5)
  const jitter = () => 0.85 + rand() * 0.3
  for (let i = 0; i < 4; i++) {
    chromaticSpike(ctx, (i / 4) * TAU, 0.98 * jitter(), 0.055, item.color, 0.95)
  }
  for (let i = 0; i < 4; i++) {
    spike(ctx, (i / 4) * TAU + Math.PI / 4, 0.34 * jitter(), 0.035, item.color, 0.5)
  }
  core(ctx, 0.14)
}

const drawStar: Draw = (ctx, item) => {
  bloom(ctx, 0.95, item.color, 0.4)
  luminousBody(
    ctx,
    () => {
      ctx.beginPath()
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * TAU
        const r = i % 2 === 0 ? 0.92 : 0.4
        const x = Math.cos(a) * r
        const y = Math.sin(a) * r
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
    },
    item.color,
    0.95
  )
  core(ctx, 0.22, 0.7)
}

/** Six fine needles of uneven length. */
const drawTwinkle: Draw = (ctx, item, rand) => {
  bloom(ctx, 0.7, item.color, 0.42)
  for (let i = 0; i < 6; i++) {
    spike(ctx, (i / 6) * TAU, 0.95 * (0.7 + rand() * 0.45), 0.03, item.color, 0.9)
  }
  core(ctx, 0.11)
}

/** Cinematic lens star: long vertical, short horizontal, hot centre. */
const drawBurst: Draw = (ctx, item) => {
  bloom(ctx, 0.95, item.color, 0.6)
  chromaticSpike(ctx, -Math.PI / 2, 0.99, 0.05, item.color, 1)
  chromaticSpike(ctx, Math.PI / 2, 0.99, 0.05, item.color, 1)
  spike(ctx, 0, 0.52, 0.045, item.color, 0.8)
  spike(ctx, Math.PI, 0.52, 0.045, item.color, 0.8)
  for (let i = 0; i < 4; i++) spike(ctx, (i / 4) * TAU + Math.PI / 4, 0.22, 0.03, item.color, 0.45)
  core(ctx, 0.2)
}

/** Real glitter powder: many small grains, each with its own tiny bloom. */
const drawDust: Draw = (ctx, item, rand) => {
  bloom(ctx, 1, item.color, 0.16)
  for (let i = 0; i < 26; i++) {
    const a = rand() * TAU
    const r = Math.sqrt(rand()) * 0.95
    const s = 0.025 + rand() * 0.06
    const bright = 0.35 + rand() * 0.65
    ctx.save()
    ctx.translate(Math.cos(a) * r, Math.sin(a) * r)
    bloom(ctx, s * 3.2, item.color, bright * 0.5)
    core(ctx, s, bright)
    ctx.restore()
  }
}

/** Defocused light: hexagonal aperture, bright rim, soft interior. */
const drawBokeh: Draw = (ctx, item) => {
  bloom(ctx, 1, item.color, 0.1)
  // Defocused light is nearly hollow: a faint interior, a distinctly brighter
  // rim where the aperture edge lands, and no hard boundary anywhere.
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.88)
  g.addColorStop(0, withAlpha(item.color, 0.06))
  g.addColorStop(0.55, withAlpha(item.color, 0.09))
  g.addColorStop(0.8, withAlpha(item.color, 0.2))
  g.addColorStop(0.93, withAlpha(item.color, 0.42))
  g.addColorStop(0.99, withAlpha(item.color, 0.05))
  g.addColorStop(1, withAlpha(item.color, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * TAU
    const x = Math.cos(a) * 0.92
    const y = Math.sin(a) * 0.92
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fill()
}

const drawRing: Draw = (ctx, item) => {
  bloom(ctx, 0.95, item.color, 0.22)
  const g = ctx.createLinearGradient(-0.8, -0.8, 0.8, 0.8)
  g.addColorStop(0, `rgba(255,255,255,1)`)
  g.addColorStop(0.35, withAlpha(item.color, 0.8))
  g.addColorStop(1, withAlpha(item.color, 0.12))
  ctx.strokeStyle = g
  ctx.lineWidth = 0.07
  ctx.beginPath()
  ctx.arc(0, 0, 0.76, 0, TAU)
  ctx.stroke()
  // The glint where the ring catches the light.
  ctx.save()
  ctx.translate(-0.54, -0.54)
  bloom(ctx, 0.3, item.color, 0.6)
  core(ctx, 0.09)
  ctx.restore()
}

const drawDiamond: Draw = (ctx, item) => {
  bloom(ctx, 0.9, item.color, 0.42)
  luminousBody(
    ctx,
    () => {
      ctx.beginPath()
      ctx.moveTo(0, -0.92)
      ctx.lineTo(0.56, -0.1)
      ctx.lineTo(0, 0.92)
      ctx.lineTo(-0.56, -0.1)
      ctx.closePath()
    },
    item.color,
    0.9
  )
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.beginPath()
  ctx.moveTo(0, -0.92)
  ctx.lineTo(0.56, -0.1)
  ctx.lineTo(0, -0.2)
  ctx.closePath()
  ctx.fill()
  chromaticSpike(ctx, -Math.PI / 2, 0.85, 0.035, item.color, 0.55)
  core(ctx, 0.16, 0.8)
}

const drawHeart: Draw = (ctx, item) => {
  bloom(ctx, 0.95, item.color, 0.45)
  const path = () => {
    ctx.beginPath()
    ctx.moveTo(0, 0.86)
    ctx.bezierCurveTo(-1, 0.05, -0.55, -0.92, 0, -0.32)
    ctx.bezierCurveTo(0.55, -0.92, 1, 0.05, 0, 0.86)
    ctx.closePath()
  }
  luminousBody(ctx, path, item.color, 0.95)
  ctx.save()
  ctx.translate(-0.3, -0.3)
  core(ctx, 0.17, 0.55)
  ctx.restore()
}

const drawSnowflake: Draw = (ctx, item) => {
  bloom(ctx, 0.9, item.color, 0.38)
  ctx.strokeStyle = withAlpha(item.color, 0.55)
  ctx.lineWidth = 0.11
  ctx.lineCap = 'round'
  for (let i = 0; i < 6; i++) {
    ctx.save()
    ctx.rotate((i / 6) * TAU)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(0, -0.9)
    ctx.stroke()
    ctx.restore()
  }
  ctx.strokeStyle = `rgba(255,255,255,0.92)`
  ctx.lineWidth = 0.045
  ctx.lineCap = 'round'
  for (let i = 0; i < 6; i++) {
    ctx.save()
    ctx.rotate((i / 6) * TAU)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(0, -0.9)
    ctx.stroke()
    for (const [at, len] of [
      [0.4, 0.22],
      [0.66, 0.15],
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
  core(ctx, 0.13, 0.8)
}

/** Anamorphic streak — one long horizontal flare, as a wide lens gives. */
const drawFlare: Draw = (ctx, item) => {
  const g = ctx.createLinearGradient(-1, 0, 1, 0)
  g.addColorStop(0, withAlpha(item.color, 0))
  g.addColorStop(0.32, withAlpha(item.color, 0.4))
  g.addColorStop(0.5, 'rgba(255,255,255,0.95)')
  g.addColorStop(0.68, withAlpha(item.color, 0.4))
  g.addColorStop(1, withAlpha(item.color, 0))
  ctx.fillStyle = g
  for (const w of [0.11, 0.045]) {
    ctx.beginPath()
    ctx.moveTo(-0.99, 0)
    ctx.quadraticCurveTo(0, -w, 0.99, 0)
    ctx.quadraticCurveTo(0, w, -0.99, 0)
    ctx.closePath()
    ctx.fill()
  }
  spike(ctx, -Math.PI / 2, 0.34, 0.05, item.color, 0.55)
  spike(ctx, Math.PI / 2, 0.34, 0.05, item.color, 0.55)
  bloom(ctx, 0.5, item.color, 0.65)
  core(ctx, 0.16)
}

/** Refraction: the spikes split into spectral colours. */
const drawPrism: Draw = (ctx, item, rand) => {
  bloom(ctx, 0.85, item.color, 0.34)
  const hues = ['#ff5f6d', '#ffb45e', '#ffe86e', '#7dffb0', '#6ec6ff', '#c08cff']
  for (let i = 0; i < hues.length; i++) {
    const a = (i / hues.length) * TAU + rand() * 0.25
    spike(ctx, a, 0.97 * (0.78 + rand() * 0.3), 0.055, hues[i], 0.95)
  }
  for (let i = 0; i < 4; i++) spike(ctx, (i / 4) * TAU, 0.3, 0.03, '#ffffff', 0.7)
  core(ctx, 0.17)
}

/** Just glow — a soft orb with no geometry at all. */
const drawHalo: Draw = (ctx, item) => {
  bloom(ctx, 1, item.color, 0.75)
  core(ctx, 0.24, 0.6)
}

/** A field of fine crossed glints — the look of fabric catching light. */
const drawShimmer: Draw = (ctx, item, rand) => {
  bloom(ctx, 1, item.color, 0.18)
  for (let i = 0; i < 13; i++) {
    const a = rand() * TAU
    const r = Math.sqrt(rand()) * 0.88
    const s = 0.16 + rand() * 0.28
    ctx.save()
    ctx.translate(Math.cos(a) * r, Math.sin(a) * r)
    ctx.rotate(rand() * TAU)
    const bright = 0.45 + rand() * 0.55
    spike(ctx, 0, s, 0.02, item.color, bright)
    spike(ctx, Math.PI, s, 0.02, item.color, bright)
    spike(ctx, Math.PI / 2, s * 0.5, 0.015, item.color, bright * 0.7)
    spike(ctx, -Math.PI / 2, s * 0.5, 0.015, item.color, bright * 0.7)
    core(ctx, s * 0.16, bright)
    ctx.restore()
  }
}

/** A bright head trailing dust — a shooting star. */
const drawComet: Draw = (ctx, item, rand) => {
  ctx.save()
  ctx.translate(0.42, 0)
  bloom(ctx, 0.5, item.color, 0.6)
  for (let i = 0; i < 4; i++) spike(ctx, (i / 4) * TAU, 0.34, 0.03, item.color, 0.8)
  core(ctx, 0.15)
  ctx.restore()
  const g = ctx.createLinearGradient(0.42, 0, -1, 0)
  g.addColorStop(0, withAlpha(item.color, 0.55))
  g.addColorStop(1, withAlpha(item.color, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.moveTo(0.42, -0.075)
  ctx.quadraticCurveTo(-0.4, -0.13, -0.98, 0)
  ctx.quadraticCurveTo(-0.4, 0.13, 0.42, 0.075)
  ctx.closePath()
  ctx.fill()
  for (let i = 0; i < 9; i++) {
    const t = rand()
    const x = 0.42 - t * 1.3
    const y = (rand() - 0.5) * 0.16 * (0.3 + t)
    ctx.save()
    ctx.translate(x, y)
    core(ctx, 0.018 + rand() * 0.03, (1 - t) * 0.8)
    ctx.restore()
  }
}

/** A fine star-filter cross on a small, hard light. */
const drawGlint: Draw = (ctx, item) => {
  bloom(ctx, 0.45, item.color, 0.55)
  chromaticSpike(ctx, 0, 0.98, 0.028, item.color, 0.9)
  chromaticSpike(ctx, Math.PI, 0.98, 0.028, item.color, 0.9)
  spike(ctx, -Math.PI / 2, 0.62, 0.024, item.color, 0.75)
  spike(ctx, Math.PI / 2, 0.62, 0.024, item.color, 0.75)
  core(ctx, 0.1)
}

/** A photographic plate, tinted and feathered, drawn into the unit box.
 *  Draws nothing until the image has loaded — `loadPlatesFor` is what the
 *  overlay and the exporter await. */
function plateDrawer(id: PlateId): Draw {
  return (ctx, item) => {
    const p = getPlate(id, item.color)
    if (!p) return
    const a = plateAspect(id)
    ctx.drawImage(p, -1, -a, 2, 2 * a)
  }
}

const drawGrain: Draw = (ctx, item, rand) => {
  bloom(ctx, 0.95, item.color, 0.12)
  plateDrawer('grain')(ctx, item, rand)
}

export const SHAPE_DEFS: Record<GlitterShape, ShapeDef> = {
  spark: { draw: drawSpark, satellites: 3, anchor: 0.62 },
  star: { draw: drawStar },
  twinkle: { draw: drawTwinkle, satellites: 2, anchor: 0.7 },
  burst: { draw: drawBurst },
  dust: { draw: drawDust },
  bokeh: { draw: drawBokeh, satellites: 3, anchor: 0.6 },
  ring: { draw: drawRing },
  diamond: { draw: drawDiamond },
  heart: { draw: drawHeart },
  snowflake: { draw: drawSnowflake },
  flare: { draw: drawFlare, shadeAspect: 0.28 },
  prism: { draw: drawPrism },
  halo: { draw: drawHalo },
  shimmer: { draw: drawShimmer },
  comet: { draw: drawComet, shadeAspect: 0.5 },
  glint: { draw: drawGlint, satellites: 2, anchor: 0.68 },
  grain: { draw: drawGrain },
  lensflare: { draw: plateDrawer('lensflare'), shadeAspect: 0.3 },
  bokehPlate: { draw: plateDrawer('bokehPlate') },
}

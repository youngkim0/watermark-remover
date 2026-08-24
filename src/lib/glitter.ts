// Glitter overlay items: decorative sparkles drawn onto a canvas with the same
// routine for the live preview and the exported PNG, so what you see is
// exactly what you save.
//
// Sparkles are drawn as LIGHT, not as paint: inside one sparkle the layers
// accumulate with 'lighter', so a hot white core sits inside a tinted bloom
// with tapered, chromatically-split spikes. That shading is what separates a
// sparkle from a sticker.
//
// The overlay canvas itself composites normally, NOT with a screen blend.
// Screening was tried and rejected: on a dark photo it is indistinguishable
// from compositing normally, and on a light one it washes every sparkle away —
// and most photos have bright areas.
import { SHAPE_DEFS, rng } from '@/lib/glitterShapes'
import { loadPlates, type PlateId } from '@/lib/glitterPlates'

export type GlitterShape =
  | 'spark'
  | 'star'
  | 'twinkle'
  | 'burst'
  | 'dust'
  | 'bokeh'
  | 'diamond'
  | 'heart'
  | 'snowflake'
  | 'prism'
  | 'halo'
  | 'sparkles'
  | 'foil'
  | 'sequin'
  | 'blossom'
  | 'gem'
  | 'confetti'
  | 'grain'
  | 'bokehPlate'

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

/** Palette order — also the order the toolbar strip renders. Points of light
 *  first, then objects, then the wide/atmospheric ones. */
export const GLITTER_SHAPES: GlitterShape[] = [
  'spark',
  'sparkles',
  'burst',
  'twinkle',
  'prism',
  'star',
  'gem',
  'sequin',
  'blossom',
  'heart',
  'diamond',
  'snowflake',
  'dust',
  'foil',
  'confetti',
  'bokeh',
  'halo',
  'grain',
  'bokehPlate',
]

const TAU = Math.PI * 2

/** How far a shape may rotate at placement. A shape with a canonical "up"
 *  gets a small tilt; the rest take a full turn so a cluster never looks
 *  stamped. The symmetric shapes cost nothing to rotate freely — a 5-point
 *  star's full turn is visually ±36°, a 6-arm snowflake's ±30°, and dust,
 *  bokeh, halo and ring look identical at any angle. A heart does not: it has
 *  no rotational symmetry, so a full turn lands it upside down. */
const ROTATION_JITTER: Record<GlitterShape, number> = {
  spark: Math.PI,
  star: Math.PI,
  twinkle: Math.PI,
  burst: Math.PI,
  dust: Math.PI,
  bokeh: Math.PI,
  snowflake: Math.PI,
  prism: Math.PI,
  halo: Math.PI,
  sparkles: Math.PI,
  foil: Math.PI,
  sequin: Math.PI,
  blossom: Math.PI,
  gem: Math.PI,
  confetti: Math.PI,
  grain: Math.PI,
  bokehPlate: Math.PI,
  diamond: 0.26, // ~15° — 2-fold symmetry, so a full turn tips it over
  heart: 0.17, // ~10° — a slight tilt is charming, sideways is broken
}

export function drawGlitterItems(ctx: CanvasRenderingContext2D, items: GlitterItem[]) {
  for (const item of items) {
    const r = item.size / 2
    if (r <= 0) continue
    const def = SHAPE_DEFS[item.shape]
    const rand = rng(item.seed)
    ctx.save()
    ctx.translate(item.x, item.y)
    ctx.rotate(item.rotation)
    ctx.scale(r, r)

    // A whisper of shade under the sparkle. On a dark photo this does
    // nothing — there is nothing left to darken. On a bright one it is the
    // only thing that lets a white highlight read at all, since a screen
    // cannot draw brighter than white. Kept far below the threshold where it
    // would look like a drop shadow.
    ctx.save()
    ctx.scale(1, def.shadeAspect ?? 1)
    const shade = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.8)
    shade.addColorStop(0, 'rgba(30,24,12,0.1)')
    shade.addColorStop(0.35, 'rgba(30,24,12,0.055)')
    shade.addColorStop(1, 'rgba(30,24,12,0)')
    ctx.fillStyle = shade
    ctx.beginPath()
    ctx.arc(0, 0, 0.8, 0, TAU)
    ctx.fill()
    ctx.restore()

    // Light accumulates: two sparkles overlapping get brighter, they don't
    // occlude each other.
    ctx.globalCompositeOperation = 'lighter'

    const satellites = def.satellites ?? 0
    const anchor = satellites > 0 ? (def.anchor ?? 0.6) : 1
    ctx.save()
    ctx.scale(anchor, anchor)
    def.draw(ctx, item, rand)
    ctx.restore()

    // Company. A lone symmetrical mark is the sticker tell; real glitter
    // arrives as a constellation. Satellites stay inside radius 1 so the
    // footprint measureGlitterItem promises remains truthful.
    for (let i = 0; i < satellites; i++) {
      const a = rand() * TAU
      const s = 0.14 + rand() * 0.18
      const d = Math.min(0.42 + rand() * 0.5, 1 - s)
      ctx.save()
      ctx.globalAlpha = 0.35 + rand() * 0.4
      ctx.translate(Math.cos(a) * d, Math.sin(a) * d)
      ctx.rotate(rand() * TAU)
      ctx.scale(s, s)
      def.draw(ctx, item, rand)
      ctx.restore()
    }
    ctx.restore()
  }
}

/** Which photographic plates a set of items needs. */
const PLATE_OF: Partial<Record<GlitterShape, PlateId>> = {
  grain: 'grain',
  bokehPlate: 'bokehPlate',
}

/**
 * Load the plates these items need. A plate shape draws nothing until its
 * image is in memory, so the overlay redraws once this resolves and the
 * exporter awaits it — the same contract the text tool has with its fonts.
 */
export function loadPlatesFor(items: GlitterItem[]): Promise<unknown> {
  const ids = new Set<PlateId>()
  for (const it of items) {
    const id = PLATE_OF[it.shape]
    if (id) ids.add(id)
  }
  return loadPlates([...ids])
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

/** Placement-time randomness, bounded per shape. */
export function randomRotation(shape: GlitterShape): number {
  return (Math.random() * 2 - 1) * ROTATION_JITTER[shape]
}

export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0
}

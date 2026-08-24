// Photographic plates: real glitter powder, a real anamorphic flare, real
// defocused bokeh. Procedural shapes can imitate the geometry of light but not
// its texture, so these three carry the grain a canvas path cannot.
//
// Each plate is white-on-black (bokeh keeps its own colours), which is what
// lets them composite the same way the procedural shapes do: sparkles draw
// with 'lighter', and black adds nothing. No alpha channel is needed, so they
// ship as JPEGs — a PNG of fine speckle is five times the size.

export type PlateId = 'grain' | 'lensflare' | 'bokehPlate'

type PlateSpec = {
  src: string
  /** Height as a fraction of width, for the plates that aren't square. */
  aspect: number
  /** Feather the edges into a circle. Off for the flare, which is a strip. */
  vignette: boolean
  /** How strongly the item's colour tints the plate. Bokeh keeps most of its
   *  own hues — that multi-coloured spill is the whole point of it. */
  tint: number
}

const PLATES: Record<PlateId, PlateSpec> = {
  grain: { src: '/glitter/grain.jpg', aspect: 1, vignette: true, tint: 1 },
  lensflare: { src: '/glitter/flare.jpg', aspect: 210 / 768, vignette: false, tint: 0.85 },
  bokehPlate: { src: '/glitter/bokeh.jpg', aspect: 1, vignette: true, tint: 0.35 },
}

export const PLATE_IDS = Object.keys(PLATES) as PlateId[]

export function plateAspect(id: PlateId): number {
  return PLATES[id].aspect
}

const images = new Map<PlateId, HTMLImageElement>()
const loading = new Map<PlateId, Promise<void>>()

function load(id: PlateId): Promise<void> {
  const existing = loading.get(id)
  if (existing) return existing
  const p = new Promise<void>((resolve) => {
    if (typeof document === 'undefined') return resolve()
    const img = new Image()
    img.onload = () => {
      images.set(id, img)
      resolve()
    }
    img.onerror = () => resolve() // a missing plate just draws nothing
    img.src = PLATES[id].src
  })
  loading.set(id, p)
  return p
}

/** Await the plates a set of items needs, so an export never bakes in a
 *  half-loaded sparkle. Mirrors how the text tool awaits its fonts. */
export function loadPlates(ids: PlateId[]): Promise<unknown> {
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(ids.map(load))
}

// Tinting and feathering a plate costs a full offscreen composite, so the
// result is cached per (plate, colour). A session touches a handful of
// colours, and the cache is capped well below anything that matters.
const MAX_CACHE = 14
const cache = new Map<string, HTMLCanvasElement>()

const RENDER_W = 512

function build(id: PlateId, color: string): HTMLCanvasElement | null {
  const img = images.get(id)
  if (!img) return null
  const spec = PLATES[id]
  const w = RENDER_W
  const h = Math.round(RENDER_W * spec.aspect)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)

  if (spec.tint > 0) {
    ctx.save()
    ctx.globalAlpha = spec.tint
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = color
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  }

  // Black is not transparent. These plates are lit subjects on black, so
  // brightness has to become alpha — otherwise the dark half of the frame
  // composites as an opaque box around the sparkle. RGB is renormalised so a
  // dim pixel goes transparent rather than muddy.
  const px = ctx.getImageData(0, 0, w, h)
  const d = px.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]
    const g2 = d[i + 1]
    const b = d[i + 2]
    const peak = r > g2 ? (r > b ? r : b) : g2 > b ? g2 : b
    if (peak === 0) {
      d[i + 3] = 0
      continue
    }
    const k = 255 / peak
    d[i] = Math.min(255, r * k)
    d[i + 1] = Math.min(255, g2 * k)
    d[i + 2] = Math.min(255, b * k)
    d[i + 3] = peak
  }
  ctx.putImageData(px, 0, 0)

  if (spec.vignette) {
    // Feather to a disc: a plate is a rectangular crop of a texture, and a
    // hard edge through a field of speckles reads instantly as a pasted box.
    ctx.globalCompositeOperation = 'destination-in'
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
    g.addColorStop(0, 'rgba(0,0,0,1)')
    g.addColorStop(0.62, 'rgba(0,0,0,0.95)')
    g.addColorStop(0.88, 'rgba(0,0,0,0.35)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
  }
  return c
}

/** The tinted, feathered plate ready to draw, or null while it still loads.
 *  Requesting a plate that hasn't loaded starts the load. */
export function getPlate(id: PlateId, color: string): HTMLCanvasElement | null {
  if (!images.has(id)) {
    void load(id)
    return null
  }
  const key = `${id}|${color}`
  const hit = cache.get(key)
  if (hit) return hit
  const built = build(id, color)
  if (!built) return null
  cache.set(key, built)
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return built
}

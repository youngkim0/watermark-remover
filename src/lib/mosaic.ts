import type { InpaintPatch } from '@/lib/inpaint'

type Dims = { w: number; h: number }
export type BrushStroke = { width: number; points: { x: number; y: number }[] }

/** Cell size in natural px for a slider level (1–10), scaled to the image so
 *  a level looks the same on a phone screenshot and a camera photo. */
export function mosaicBlock(level: number, d: Dims): number {
  return Math.max(4, Math.round((Math.max(d.w, d.h) * level) / 300))
}

/**
 * Pixelate every grid cell the stroke touches, in place on `ctx`. The grid is
 * anchored at the image origin, so overlapping strokes at the same cell size
 * line up instead of producing a second, offset grid. Whole cells are filled
 * (not just the brushed pixels) — the blocky edge is what reads as a mosaic.
 * Returns the pixels it replaced, for undo.
 */
export function applyMosaic(
  ctx: CanvasRenderingContext2D,
  stroke: BrushStroke,
  block: number,
  d: Dims
): InpaintPatch | null {
  const r = stroke.width / 2 + 1
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
  for (const p of stroke.points) {
    bx0 = Math.min(bx0, p.x - r); by0 = Math.min(by0, p.y - r)
    bx1 = Math.max(bx1, p.x + r); by1 = Math.max(by1, p.y + r)
  }
  const x0 = Math.max(0, Math.floor(bx0 / block) * block)
  const y0 = Math.max(0, Math.floor(by0 / block) * block)
  const x1 = Math.min(d.w, Math.ceil(bx1 / block) * block)
  const y1 = Math.min(d.h, Math.ceil(by1 / block) * block)
  const w = x1 - x0, h = y1 - y0
  if (w <= 0 || h <= 0) return null

  // Rasterize the stroke over just its window to learn which cells it hits.
  const cov = document.createElement('canvas')
  cov.width = w
  cov.height = h
  const cctx = cov.getContext('2d', { willReadFrequently: true })!
  cctx.translate(-x0, -y0)
  cctx.fillStyle = cctx.strokeStyle = '#000'
  cctx.lineCap = 'round'
  cctx.lineJoin = 'round'
  cctx.lineWidth = stroke.width
  const [first, ...rest] = stroke.points
  cctx.beginPath()
  cctx.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2)
  cctx.fill()
  if (rest.length > 0) {
    cctx.beginPath()
    cctx.moveTo(first.x, first.y)
    for (const p of rest) cctx.lineTo(p.x, p.y)
    cctx.stroke()
  }
  const mask = cctx.getImageData(0, 0, w, h).data
  cov.width = cov.height = 0

  const img = ctx.getImageData(x0, y0, w, h)
  const prior = new ImageData(new Uint8ClampedArray(img.data), w, h)
  const px = img.data
  let changed = false
  for (let cy = 0; cy < h; cy += block) {
    const ch = Math.min(block, h - cy)
    for (let cx = 0; cx < w; cx += block) {
      const cw = Math.min(block, w - cx)
      let hit = false
      for (let y = cy; y < cy + ch && !hit; y++) {
        for (let x = cx; x < cx + cw; x++) {
          if (mask[(y * w + x) * 4 + 3] > 0) {
            hit = true
            break
          }
        }
      }
      if (!hit) continue
      let rr = 0, gg = 0, bb = 0, aa = 0
      for (let y = cy; y < cy + ch; y++) {
        for (let x = cx; x < cx + cw; x++) {
          const i = (y * w + x) * 4
          rr += px[i]; gg += px[i + 1]; bb += px[i + 2]; aa += px[i + 3]
        }
      }
      const n = cw * ch
      rr /= n; gg /= n; bb /= n; aa /= n
      for (let y = cy; y < cy + ch; y++) {
        for (let x = cx; x < cx + cw; x++) {
          const i = (y * w + x) * 4
          px[i] = rr; px[i + 1] = gg; px[i + 2] = bb; px[i + 3] = aa
        }
      }
      changed = true
    }
  }
  if (!changed) return null
  ctx.putImageData(img, x0, y0)
  return { x: x0, y: y0, data: prior }
}

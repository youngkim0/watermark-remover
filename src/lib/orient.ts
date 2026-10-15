// Lossless 90° rotations and flips. Every mapping works in continuous
// natural-pixel coordinates (pixel edges, not centers), so a point, a rect
// and a canvas all transform consistently with one another.

export type OrientOp = 'cw' | 'ccw' | 'flipH' | 'flipV'

type Dims = { w: number; h: number }
type Rect = { x: number; y: number; w: number; h: number }

/** Net orientation as a 2×2 integer matrix [a, b, c, d] acting on (x, y). */
export type Orientation = readonly [number, number, number, number]
export const IDENTITY_ORIENTATION: Orientation = [1, 0, 0, 1]

const OP_MATRIX: Record<OrientOp, Orientation> = {
  cw: [0, -1, 1, 0],
  ccw: [0, 1, -1, 0],
  flipH: [-1, 0, 0, 1],
  flipV: [1, 0, 0, -1],
}

export const inverseOrient = (op: OrientOp): OrientOp =>
  op === 'cw' ? 'ccw' : op === 'ccw' ? 'cw' : op

/** Orientation after applying `op` on top of `m`. */
export function composeOrientation(m: Orientation, op: OrientOp): Orientation {
  const [a, b, c, d] = OP_MATRIX[op]
  return [a * m[0] + b * m[2], a * m[1] + b * m[3], c * m[0] + d * m[2], c * m[1] + d * m[3]]
}

export const isIdentityOrientation = (m: Orientation) =>
  m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1

export function orientDims(d: Dims, op: OrientOp): Dims {
  return op === 'cw' || op === 'ccw' ? { w: d.h, h: d.w } : { w: d.w, h: d.h }
}

/** Map a point on a `d`-sized image to the oriented image. */
export function orientPoint(x: number, y: number, d: Dims, op: OrientOp): { x: number; y: number } {
  switch (op) {
    case 'cw':
      return { x: d.h - y, y: x }
    case 'ccw':
      return { x: y, y: d.w - x }
    case 'flipH':
      return { x: d.w - x, y }
    case 'flipV':
      return { x, y: d.h - y }
  }
}

export function orientRect(r: Rect, d: Dims, op: OrientOp): Rect {
  const a = orientPoint(r.x, r.y, d, op)
  const b = orientPoint(r.x + r.w, r.y + r.h, d, op)
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

/** Pixel-exact copy of `img` under `op`. Used for small erase-undo patches;
 *  full planes go through `orientCanvas` instead (no JS-side copy). */
export function orientImageData(img: ImageData, op: OrientOp): ImageData {
  const { width: w, height: h } = img
  const out = orientDims({ w, h }, op)
  const dst = new ImageData(out.w, out.h)
  const s = new Uint32Array(img.data.buffer, img.data.byteOffset, w * h)
  const t = new Uint32Array(dst.data.buffer)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx: number, dy: number
      switch (op) {
        case 'cw':
          dx = h - 1 - y; dy = x
          break
        case 'ccw':
          dx = y; dy = w - 1 - x
          break
        case 'flipH':
          dx = w - 1 - x; dy = y
          break
        default:
          dx = x; dy = h - 1 - y
      }
      t[dy * out.w + dx] = s[y * w + x]
    }
  }
  return dst
}

/** Re-orient a canvas in place (resizes it). Goes through a scratch canvas
 *  under an exact integer transform, so pixels are moved, never resampled. */
export function orientCanvas(canvas: HTMLCanvasElement, op: OrientOp) {
  const d = { w: canvas.width, h: canvas.height }
  const out = orientDims(d, op)
  const scratch = document.createElement('canvas')
  scratch.width = out.w
  scratch.height = out.h
  const sctx = scratch.getContext('2d')!
  sctx.imageSmoothingEnabled = false
  switch (op) {
    case 'cw':
      sctx.setTransform(0, 1, -1, 0, d.h, 0)
      break
    case 'ccw':
      sctx.setTransform(0, -1, 1, 0, 0, d.w)
      break
    case 'flipH':
      sctx.setTransform(-1, 0, 0, 1, d.w, 0)
      break
    case 'flipV':
      sctx.setTransform(1, 0, 0, -1, 0, d.h)
      break
  }
  sctx.drawImage(canvas, 0, 0)
  canvas.width = out.w
  canvas.height = out.h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(scratch, 0, 0)
  scratch.width = 0
  scratch.height = 0
}

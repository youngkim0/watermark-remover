// Pure helpers for the background-removal matte (IS-Net). No imports, so
// `node --experimental-strip-types --test` can load this file directly.

/** IS-Net's fixed square input; images are stretched to it, not letterboxed. */
export const MATTE_SIZE = 1024

/** Alpha levels curve for the raw matte (0..1 in and out): faint haze goes
 *  fully transparent, a near-solid subject fully opaque, and the band in
 *  between keeps a smooth edge for hair and antialiasing. */
export function cleanAlpha(a: number): number {
  const lo = 0.06
  const hi = 0.8
  if (a <= lo) return 0
  if (a >= hi) return 1
  const t = (a - lo) / (hi - lo)
  return t * t * (3 - 2 * t)
}

/** MATTE_SIZE² RGBA → the model's planar float input: each pixel flattened
 *  over white by its alpha, scaled by the image's max channel value, and
 *  centred on zero (`v / max − 0.5`, std 1 — IS-Net's training transform). */
export function toModelInput(rgba: Uint8ClampedArray): Float32Array {
  const n = MATTE_SIZE * MATTE_SIZE
  const flat = new Float32Array(3 * n)
  let max = 0
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255
    for (let k = 0; k < 3; k++) {
      const v = rgba[i * 4 + k] * a + 255 * (1 - a)
      flat[k * n + i] = v
      if (v > max) max = v
    }
  }
  const m = Math.max(max, 1e-6)
  for (let i = 0; i < flat.length; i++) flat[i] = flat[i] / m - 0.5
  return flat
}

/** The model's MATTE_SIZE² map → white RGBA whose alpha is the cleaned,
 *  min–max normalised matte, ready for putImageData. A flat map (no
 *  contrast at all) means nothing was found: all transparent. */
export function outputToAlpha(out: Float32Array): Uint8ClampedArray {
  let lo = Infinity
  let hi = -Infinity
  for (const v of out) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const rgba = new Uint8ClampedArray(out.length * 4).fill(255)
  const span = hi - lo
  for (let i = 0; i < out.length; i++) {
    rgba[i * 4 + 3] = span > 0 ? Math.round(cleanAlpha((out[i] - lo) / span) * 255) : 0
  }
  return rgba
}

/** One byte per pixel — the cutout's alpha, kept for undo/redo. */
export type AlphaPlane = { w: number; h: number; data: Uint8Array }

/** Pixel-exact rotate/flip of a plane, with the same mapping as
 *  orientImageData in orient.ts. */
export function orientPlane(p: AlphaPlane, op: 'cw' | 'ccw' | 'flipH' | 'flipV'): AlphaPlane {
  const { w, h } = p
  const rot = op === 'cw' || op === 'ccw'
  const ow = rot ? h : w
  const oh = rot ? w : h
  const data = new Uint8Array(w * h)
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
      data[dy * ow + dx] = p.data[y * w + x]
    }
  }
  return { w: ow, h: oh, data }
}

import type { Rect } from '@/lib/inpaint'

export type DetectedMark = {
  rect: Rect // natural-image coords, padded, clamped
  score: number // blurred-edge NCC in [0, 1] (basin score)
  sharp: number // unblurred-edge NCC at the same spot (shape verification)
  templateId: string
}

/** Calibration constants. Tuned against docs/samples/ (see the plan). */
export const DETECT_TUNING = {
  // Glyph size as a fraction of min(imageW, imageH). Real Gemini sample:
  // 0.0469. Range widened for crops/re-encodes.
  scaleRange: [0.03, 0.075] as [number, number],
  scaleSteps: 6,
  // Acceptance cuts, placed from the measured joint score distribution
  // (true glyphs: blur+sharp >= 1.28, worst lookalike: 1.12; see the plan's
  // calibration record). Blurred NCC finds the basin; unblurred NCC verifies
  // the sharp star shape; the sum separates the clusters.
  nccThreshold: 0.6,
  sharpThreshold: 0.45,
  sumThreshold: 1.25,
  // The ✦ is a white overlay: glyph interior must be brighter than its
  // surround by at least this much (real sample: +13 on a light bg).
  minBrightnessDelta: 5,
  // Superellipse cusp exponent for the drawn star: |x|^p + |y|^p <= r^p.
  // Fitted against the real Gemini sample (NCC 0.95 at p=0.65 vs 0.77 at 0.6).
  starExponent: 0.65,
  // Saturate Sobel magnitudes at this value so strong content edges can't
  // dominate the correlation variance and drown the faint overlay's edges.
  edgeCap: 64,
  // Long side of the downscaled search image.
  searchSize: 768,
  // Padding added around an accepted glyph before inpainting.
  padFrac: 0.2,
}

type Template = {
  id: string
  /** Alpha silhouette of the glyph at `size`×`size` px. */
  draw: (size: number) => Float32Array
  scaleRange: [number, number]
}

/** Gemini / Nano Banana 4-point sparkle: an astroid-like star
 *  |x|^p + |y|^p <= r^p with cusps at N/E/S/W. */
function drawSparkle(size: number): Float32Array {
  const a = new Float32Array(size * size)
  const r = size / 2
  const p = DETECT_TUNING.starExponent
  const rp = Math.pow(r, p)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sample 2x2 sub-pixels for soft edges.
      let cover = 0
      for (const dy of [0.25, 0.75]) {
        for (const dx of [0.25, 0.75]) {
          const u = Math.abs(x + dx - r)
          const v = Math.abs(y + dy - r)
          if (Math.pow(u, p) + Math.pow(v, p) <= rp) cover++
        }
      }
      a[y * size + x] = cover / 4
    }
  }
  return a
}

const REGISTRY: Template[] = [
  { id: 'gemini-sparkle', draw: drawSparkle, scaleRange: DETECT_TUNING.scaleRange },
]

/* ------------------------- image-plane helpers ------------------------- */

type Plane = { data: Float32Array; w: number; h: number }

/** Luminance plane downscaled so max(w, h) <= DETECT_TUNING.searchSize. */
function toSearchPlane(image: ImageData): { plane: Plane; scale: number } {
  const scale = Math.min(1, DETECT_TUNING.searchSize / Math.max(image.width, image.height))
  const w = Math.max(1, Math.round(image.width * scale))
  const h = Math.max(1, Math.round(image.height * scale))
  const data = new Float32Array(w * h)
  const sx = image.width / w
  const sy = image.height / h
  const src = image.data
  for (let y = 0; y < h; y++) {
    const iy = Math.min(image.height - 1, Math.round((y + 0.5) * sy - 0.5))
    for (let x = 0; x < w; x++) {
      const ix = Math.min(image.width - 1, Math.round((x + 0.5) * sx - 0.5))
      const o = (iy * image.width + ix) * 4
      data[y * w + x] = 0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2]
    }
  }
  return { plane: { data, w, h }, scale }
}

/** Sobel gradient magnitude. */
function sobel(p: Plane): Plane {
  const { data, w, h } = p
  const out = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx =
        -data[i - w - 1] + data[i - w + 1] - 2 * data[i - 1] + 2 * data[i + 1] - data[i + w - 1] + data[i + w + 1]
      const gy =
        -data[i - w - 1] - 2 * data[i - w] - data[i - w + 1] + data[i + w - 1] + 2 * data[i + w] + data[i + w + 1]
      out[i] = Math.min(Math.hypot(gx, gy), DETECT_TUNING.edgeCap)
    }
  }
  return { data: out, w, h }
}

/** Separable box blur (radius r) — widens the correlation basin of thin edge
 *  maps so the coarse sweep grid can't step over a match. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const norm = 1 / (2 * r + 1)
  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc * norm
      const xOut = Math.max(0, x - r)
      const xIn = Math.min(w - 1, x + r + 1)
      acc += src[y * w + xIn] - src[y * w + xOut]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm
      const yOut = Math.max(0, y - r)
      const yIn = Math.min(h - 1, y + r + 1)
      acc += tmp[yIn * w + x] - tmp[yOut * w + x]
    }
  }
  return out
}

/** Edge map of a template silhouette (gradient magnitude of the alpha). */
function templateEdges(alpha: Float32Array, size: number): Float32Array {
  const out = new Float32Array(size * size)
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x
      const gx =
        -alpha[i - size - 1] +
        alpha[i - size + 1] -
        2 * alpha[i - 1] +
        2 * alpha[i + 1] -
        alpha[i + size - 1] +
        alpha[i + size + 1]
      const gy =
        -alpha[i - size - 1] -
        2 * alpha[i - size] -
        alpha[i - size + 1] +
        alpha[i + size - 1] +
        2 * alpha[i + size] +
        alpha[i + size + 1]
      out[i] = Math.hypot(gx, gy)
    }
  }
  return out
}

/** Zero-mean NCC of the template edge patch against the image edge plane at
 *  (ox, oy), sampling every `stride` px. */
function nccAt(edges: Plane, tpl: Float32Array, size: number, ox: number, oy: number, stride: number): number {
  let n = 0
  let sumI = 0
  let sumT = 0
  for (let y = 0; y < size; y += stride) {
    const row = (oy + y) * edges.w + ox
    const trow = y * size
    for (let x = 0; x < size; x += stride) {
      sumI += edges.data[row + x]
      sumT += tpl[trow + x]
      n++
    }
  }
  const meanI = sumI / n
  const meanT = sumT / n
  let num = 0
  let dI = 0
  let dT = 0
  for (let y = 0; y < size; y += stride) {
    const row = (oy + y) * edges.w + ox
    const trow = y * size
    for (let x = 0; x < size; x += stride) {
      const a = edges.data[row + x] - meanI
      const b = tpl[trow + x] - meanT
      num += a * b
      dI += a * a
      dT += b * b
    }
  }
  const den = Math.sqrt(dI * dT)
  return den > 1e-6 ? num / den : 0
}

/** Mean luminance inside the glyph silhouette minus mean of a surrounding
 *  ring — the white ✦ overlay must be brighter than its surround. */
function brightnessDelta(luma: Plane, alpha: Float32Array, size: number, ox: number, oy: number): number {
  let inSum = 0
  let inN = 0
  let ringSum = 0
  let ringN = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = ox + x
      const py = oy + y
      if (px < 0 || py < 0 || px >= luma.w || py >= luma.h) continue
      const v = luma.data[py * luma.w + px]
      const a = alpha[y * size + x]
      if (a > 0.6) {
        inSum += v
        inN++
      } else if (a === 0) {
        ringSum += v
        ringN++
      }
    }
  }
  if (!inN || !ringN) return 0
  return inSum / inN - ringSum / ringN
}

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0))

/* ------------------------------ main API ------------------------------ */

export async function detectMarks(image: ImageData): Promise<DetectedMark[]> {
  try {
    const { plane: luma, scale } = toSearchPlane(image)
    const edges = sobel(luma)
    const minSide = Math.min(luma.w, luma.h)
    const found: (DetectedMark & { size: number; x: number; y: number })[] = []

    for (const t of REGISTRY) {
      const [s0, s1] = t.scaleRange
      for (let k = 0; k < DETECT_TUNING.scaleSteps; k++) {
        const frac = s0 + ((s1 - s0) * k) / Math.max(1, DETECT_TUNING.scaleSteps - 1)
        const size = Math.max(8, Math.round(minSide * frac))
        if (size >= minSide) continue
        const alpha = t.draw(size)
        const blurR = Math.max(1, Math.round(size / 16))
        const tplSharp = templateEdges(alpha, size)
        const tpl = boxBlur(tplSharp, size, size, blurR)
        const edgesB: Plane = { data: boxBlur(edges.data, edges.w, edges.h, blurR), w: edges.w, h: edges.h }

        // Coarse sweep.
        const coarse = Math.max(2, Math.round(size / 4))
        const candidates: { x: number; y: number; s: number }[] = []
        for (let y = 0; y + size < luma.h; y += coarse) {
          for (let x = 0; x + size < luma.w; x += coarse) {
            const s = nccAt(edgesB, tpl, size, x, y, 2)
            if (s > DETECT_TUNING.nccThreshold * 0.7) candidates.push({ x, y, s })
          }
        }
        candidates.sort((a, b) => b.s - a.s)

        // Refine the top few at stride 1 in a local window.
        for (const c of candidates.slice(0, 5)) {
          let best = { x: c.x, y: c.y, s: -1 }
          for (let y = Math.max(0, c.y - coarse); y <= Math.min(luma.h - size - 1, c.y + coarse); y += 1) {
            for (let x = Math.max(0, c.x - coarse); x <= Math.min(luma.w - size - 1, c.x + coarse); x += 1) {
              const s = nccAt(edgesB, tpl, size, x, y, 1)
              if (s > best.s) best = { x, y, s }
            }
          }
          if (best.s < DETECT_TUNING.nccThreshold) continue
          const sharp = nccAt(edges, tplSharp, size, best.x, best.y, 1)
          if (sharp < DETECT_TUNING.sharpThreshold) continue
          if (best.s + sharp < DETECT_TUNING.sumThreshold) continue
          if (brightnessDelta(luma, alpha, size, best.x, best.y) < DETECT_TUNING.minBrightnessDelta) continue
          found.push({
            templateId: t.id,
            score: best.s,
            sharp,
            size,
            x: best.x,
            y: best.y,
            rect: { x: 0, y: 0, w: 0, h: 0 }, // filled below
          })
        }
        await yieldToLoop()
      }
    }

    // NMS: keep best-scoring of overlapping hits.
    found.sort((a, b) => b.score - a.score)
    const kept: typeof found = []
    for (const f of found) {
      const clash = kept.some((k) => {
        const ix = Math.max(0, Math.min(f.x + f.size, k.x + k.size) - Math.max(f.x, k.x))
        const iy = Math.max(0, Math.min(f.y + f.size, k.y + k.size) - Math.max(f.y, k.y))
        const inter = ix * iy
        const uni = f.size * f.size + k.size * k.size - inter
        return inter / uni > 0.3
      })
      if (!clash) kept.push(f)
    }

    // Map to natural coords with padding.
    return kept.map((f) => {
      const pad = f.size * DETECT_TUNING.padFrac
      const x = Math.max(0, Math.round((f.x - pad) / scale))
      const y = Math.max(0, Math.round((f.y - pad) / scale))
      const w = Math.min(image.width - x, Math.round((f.size + 2 * pad) / scale))
      const h = Math.min(image.height - y, Math.round((f.size + 2 * pad) / scale))
      return { rect: { x, y, w, h }, score: f.score, sharp: f.sharp, templateId: f.templateId }
    })
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') console.error('detectMarks failed', err)
    return []
  }
}

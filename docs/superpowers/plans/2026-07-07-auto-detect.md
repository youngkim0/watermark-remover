# Auto-detect Watermarks (v1 Engineered CV) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `✦ corner` preset with real detection: find the Gemini/Nano-Banana ✦ sparkle anywhere in the frame, pre-paint the erase mask over it (auto-run on image open + a `✦ detect` button), never paint a guess on a miss.

**Architecture:** A pure module `src/lib/detect.ts` does multi-scale template matching of registry glyphs on Sobel edge maps (polarity-invariant, contrast-normalized NCC), with a brightness gate exploiting the fact that the ✦ overlay always brightens. The editor gets a new replayable `detect` mask-stroke kind, the button swap, and a guarded auto-run. Calibration constants come from the real sample at `docs/samples/Gemini_Generated_Image_pfoe69pfoe69pfoe.png` (glyph = 4.69% of min side, +13 luminance on light bg, astroid-like shape p≈0.6) and are tuned in a browser harness before the editor wiring lands.

**Tech Stack:** Plain TypeScript + Canvas 2D (no new deps, no model download, no wasm). Verification: `npx tsc --noEmit`, `npm run lint`, `npm run build`, browser harness against `npm run dev`.

## Global Constraints

- **No new dependencies**; runtime deps stay `next`, `react`, `react-dom`, `onnxruntime-web`.
- **No AGPL code or models.** v1 ships no neural model at all.
- **Precision over recall:** clean images must produce zero false paints; misses are acceptable.
- **Memory:** transient search planes only (≤768² floats ≈ 2.3MB), freed on return. Never retain full-res pixel data.
- **Main-thread friendliness:** `detectMarks` yields between scales; total budget < 500ms on a 4096px-class image (desktop dev browser).
- **Reuse `Rect`** from `@/lib/inpaint`. Style: lowercase labels, `ctrl label` classes, `var(--amber)`.
- **This repo's lint** blocks ref writes/reads during render and use-before-declare (see memory `react-hooks-lint-constraints`) — run `npx tsc --noEmit && npm run lint && npm run build` before every commit.

---

## File Structure

- **Create:** `src/lib/detect.ts` — types, template registry (gemini-sparkle), full matching pipeline. Pure; no editor/React knowledge.
- **Modify:** `src/components/Editor.tsx` — `detect` stroke kind, `✦ detect` button, auto-run, status text, analytics; remove `cornerRect`/`paintCornerMask`/`'corner'` kind.
- **Modify:** `src/lib/content.ts` — landing copy that advertises the corner preset.
- **Commit as fixture:** `docs/samples/Gemini_Generated_Image_pfoe69pfoe69pfoe.png` (calibration sample, user-provided).

---

## Task 1: `detect.ts` — registry + matcher

**Files:**
- Create: `src/lib/detect.ts`

**Interfaces:**
- Consumes: `Rect` from `@/lib/inpaint`.
- Produces: `export type DetectedMark = { rect: Rect; score: number; templateId: string }` and `export async function detectMarks(image: ImageData): Promise<DetectedMark[]>`. Also `export const DETECT_TUNING` (calibration constants object) so the Task 2 harness can read/override them during tuning.

- [ ] **Step 1: Write the module**

Create `src/lib/detect.ts`:

```ts
import type { Rect } from '@/lib/inpaint'

export type DetectedMark = {
  rect: Rect // natural-image coords, padded, clamped
  score: number // NCC in [0, 1]
  templateId: string
}

/** Calibration constants. Tuned against docs/samples/ (see Task 2). */
export const DETECT_TUNING = {
  // Glyph size as a fraction of min(imageW, imageH). Real Gemini sample:
  // 0.0469. Range widened for crops/re-encodes.
  scaleRange: [0.03, 0.075] as [number, number],
  scaleSteps: 4,
  // Zero-mean NCC acceptance on edge maps. Biased for precision (no false
  // paints); tune in the harness before shipping.
  nccThreshold: 0.4,
  // The ✦ is a white overlay: glyph interior must be brighter than its
  // surround by at least this much (real sample: +13 on a light bg).
  minBrightnessDelta: 5,
  // Superellipse cusp exponent for the drawn star: |x|^p + |y|^p <= r^p.
  starExponent: 0.6,
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
      out[i] = Math.hypot(gx, gy)
    }
  }
  return { data: out, w, h }
}

/** Edge map of a template silhouette (gradient magnitude of the alpha). */
function templateEdges(alpha: Float32Array, size: number): Float32Array {
  const out = new Float32Array(size * size)
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x
      const gx =
        -alpha[i - size - 1] + alpha[i - size + 1] - 2 * alpha[i - 1] + 2 * alpha[i + 1] - alpha[i + size - 1] + alpha[i + size + 1]
      const gy =
        -alpha[i - size - 1] - 2 * alpha[i - size] - alpha[i - size + 1] + alpha[i + size - 1] + 2 * alpha[i + size] + alpha[i + size + 1]
      out[i] = Math.hypot(gx, gy)
    }
  }
  return out
}

/** Zero-mean NCC of the template edge patch against the image edge plane at
 *  (ox, oy), sampling every `stride` px. */
function nccAt(edges: Plane, tpl: Float32Array, size: number, ox: number, oy: number, stride: number): number {
  let n = 0,
    sumI = 0,
    sumT = 0
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
  let num = 0,
    dI = 0,
    dT = 0
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
  let inSum = 0,
    inN = 0,
    ringSum = 0,
    ringN = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = ox + x,
        py = oy + y
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
        const tpl = templateEdges(alpha, size)

        // Coarse sweep.
        const coarse = Math.max(2, Math.round(size / 4))
        const candidates: { x: number; y: number; s: number }[] = []
        for (let y = 0; y + size < luma.h; y += coarse) {
          for (let x = 0; x + size < luma.w; x += coarse) {
            const s = nccAt(edges, tpl, size, x, y, 2)
            if (s > DETECT_TUNING.nccThreshold * 0.7) candidates.push({ x, y, s })
          }
        }
        candidates.sort((a, b) => b.s - a.s)

        // Refine the top few at stride 1 in a local window.
        for (const c of candidates.slice(0, 5)) {
          let best = { x: c.x, y: c.y, s: -1 }
          for (let y = Math.max(0, c.y - coarse); y <= Math.min(luma.h - size - 1, c.y + coarse); y += 1) {
            for (let x = Math.max(0, c.x - coarse); x <= Math.min(luma.w - size - 1, c.x + coarse); x += 1) {
              const s = nccAt(edges, tpl, size, x, y, 1)
              if (s > best.s) best = { x, y, s }
            }
          }
          if (best.s < DETECT_TUNING.nccThreshold) continue
          if (brightnessDelta(luma, alpha, size, best.x, best.y) < DETECT_TUNING.minBrightnessDelta) continue
          found.push({
            templateId: t.id,
            score: best.s,
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
      return { rect: { x, y, w, h }, score: f.score, templateId: f.templateId }
    })
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') console.error('detectMarks failed', err)
    return []
  }
}
```

- [ ] **Step 2: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass (module exported but unused so far).

- [ ] **Step 3: Commit (include the calibration sample)**

```bash
git add src/lib/detect.ts docs/samples/Gemini_Generated_Image_pfoe69pfoe69pfoe.png
git commit -m "Add detect.ts: template-matching watermark detector (gemini sparkle)

Multi-scale NCC on Sobel edge maps with a brightness gate (the sparkle
is always a brightening white overlay). Constants measured from the
real Gemini sample committed under docs/samples/."
```

> Note: `docs/.DS_Store` must NOT be committed — add it to `.gitignore` if not already ignored (check with `git check-ignore docs/samples/.DS_Store`; if not ignored, append `.DS_Store` to `.gitignore` and include that in this commit).

---

## Task 2: Calibrate against the real sample (browser harness)

Tunes `DETECT_TUNING` (star exponent, NCC threshold) until the real sample and synthetic composites hit and clean images don't. This task **edits constants in `detect.ts`** and commits the result. No app code changes.

**Files:**
- Modify: `src/lib/detect.ts` (constants only)

**Interfaces:**
- Consumes: `detectMarks`, `DETECT_TUNING` (Task 1).
- Produces: calibrated constants relied on by Task 3's end-to-end behavior.

- [ ] **Step 1: Start the dev server and open a harness page**

Run `npm run dev`. In the browser (Chrome tools), open `http://localhost:3000`, then drive the harness below via the JS console. The harness imports nothing — it fetches the module through the app only if exposed; instead, evaluate detection by pasting a standalone copy? **No.** Do it the supported way: temporarily expose the function for calibration by adding to `src/components/Editor.tsx` (top of the component file, after imports):

```ts
// TEMP (calibration only, removed in Task 3): expose the detector.
if (typeof window !== 'undefined') {
  import('@/lib/detect').then((m) => {
    ;(window as unknown as Record<string, unknown>).__detect = m
  })
}
```

- [ ] **Step 2: Recall on the real sample**

In the browser console on the app page:

```js
const img = new Image()
img.src = '/samples/gemini-sample.png' // copy docs/samples/*.png to public/samples/gemini-sample.png for the harness (delete after)
await img.decode()
const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
const g = c.getContext('2d'); g.drawImage(img, 0, 0)
const marks = await window.__detect.detectMarks(g.getImageData(0, 0, c.width, c.height))
console.log(marks) // EXPECT: exactly 1 mark, rect covering ~(944,944)-(991,991) with padding
```

(Requires `cp docs/samples/Gemini_Generated_Image_pfoe69pfoe69pfoe.png public/samples/gemini-sample.png` first; `public/samples/` is deleted at the end of this task.)

If the mark is missed: lower `nccThreshold` in steps of 0.05 and/or adjust `starExponent` in [0.5, 0.75] until the sample's glyph scores comfortably above threshold (record the achieved score in the commit message). If the rect is offset, inspect `scaleSteps` coverage.

- [ ] **Step 3: Synthetic recall sweep**

Same console, composite the app's own drawn glyph is NOT valid for recall (it would test the template against itself); instead crop the real glyph and paste it onto varied backgrounds:

```js
// Crop the real 48px glyph (bbox measured: 944,944 48x48) with margin.
const glyph = document.createElement('canvas'); glyph.width = glyph.height = 64
glyph.getContext('2d').drawImage(img, 936, 936, 64, 64, 0, 0, 64, 64)
// Build 3 busy test scenes (gradient, noise, photo-like) and paste at random spots/scales.
let hits = 0, trials = 0
for (let t = 0; t < 12; t++) {
  const w = 800 + Math.floor(Math.random() * 800), h = 600 + Math.floor(Math.random() * 600)
  const s = document.createElement('canvas'); s.width = w; s.height = h
  const sg = s.getContext('2d')
  const grad = sg.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, `hsl(${Math.random() * 360},60%,${30 + Math.random() * 40}%)`)
  grad.addColorStop(1, `hsl(${Math.random() * 360},60%,${30 + Math.random() * 40}%)`)
  sg.fillStyle = grad; sg.fillRect(0, 0, w, h)
  for (let i = 0; i < 40; i++) { // clutter
    sg.fillStyle = `hsla(${Math.random() * 360},50%,50%,0.5)`
    sg.fillRect(Math.random() * w, Math.random() * h, Math.random() * 120, Math.random() * 120)
  }
  const gs = Math.round(Math.min(w, h) * (0.035 + Math.random() * 0.03))
  const gx = Math.random() * (w - gs), gy = Math.random() * (h - gs)
  sg.drawImage(glyph, 8, 8, 48, 48, gx, gy, gs, gs)
  const marks = await window.__detect.detectMarks(sg.getImageData(0, 0, w, h))
  trials++
  if (marks.some(m => gx >= m.rect.x - gs && gx + gs <= m.rect.x + m.rect.w + gs &&
                      gy >= m.rect.y - gs && gy + gs <= m.rect.y + m.rect.h + gs)) hits++
}
console.log(`recall ${hits}/${trials}`) // EXPECT >= 90% (11/12 or 12/12)
```

- [ ] **Step 4: Precision sweep (zero false positives)**

Repeat the same scene generator WITHOUT pasting the glyph, 12 scenes: `detectMarks` must return `[]` every time. If any false positive appears, raise `nccThreshold` / `minBrightnessDelta` and re-run Steps 2–3 (both must still pass).

- [ ] **Step 5: Perf check**

On one 4096×3072 synthetic scene, `console.time('detect')`/`timeEnd` around `detectMarks`: expect < 500ms.

- [ ] **Step 6: Clean up harness, commit calibrated constants**

Remove the TEMP exposure block from `Editor.tsx`, delete `public/samples/`, then:

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass.

```bash
git add src/lib/detect.ts src/components/Editor.tsx
git commit -m "Calibrate sparkle detector against the real Gemini sample

Records tuned nccThreshold/starExponent. Real-sample score: <fill in>,
synthetic recall <n>/12, false positives 0/12, detect time <n>ms on 4096px."
```

(Replace `<fill in>` placeholders with the measured numbers before committing.)

---

## Task 3: Editor integration + copy

**Files:**
- Modify: `src/components/Editor.tsx`
- Modify: `src/lib/content.ts`

**Interfaces:**
- Consumes: `detectMarks`, `DetectedMark` (Task 1, calibrated in Task 2); existing `maskStrokes`, `maskCtx`, `replayMask`, `strokesBBox`, `setMaskActions`, `track`, `MASK_COLOR`, `dims`, `busy`, `cropping`, `eraseCount`.
- Produces: user-visible feature; no new exports.

- [ ] **Step 1: Import and stroke kind**

In `src/components/Editor.tsx` add the import:

```ts
import { detectMarks } from '@/lib/detect'
```

Change the `MaskStroke` type: replace the `{ kind: 'corner' }` variant with:

```ts
type MaskStroke =
  | { kind: 'brush'; width: number; points: { x: number; y: number }[] }
  | { kind: 'detect'; rects: Rect[] }
```

- [ ] **Step 2: Remove corner code, add detect painting**

Delete `cornerRect` and `paintCornerMask` entirely. In `strokesBBox`, replace the `if (s.kind === 'corner')` branch with:

```ts
    if (s.kind === 'detect') {
      for (const r of s.rects) {
        x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y)
        x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h)
      }
    } else {
```

Add a painter next to `paintDot`/`paintSegment`:

```ts
  const paintDetect = (rects: Rect[]) => {
    const ctx = maskCtx()
    ctx.fillStyle = MASK_COLOR
    for (const r of rects) {
      ctx.beginPath()
      ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.18)
      ctx.fill()
    }
  }
```

In `replayMask`, replace the `'corner'` branch with:

```ts
      if (s.kind === 'detect') {
        paintDetect(s.rects)
        continue
      }
```

- [ ] **Step 3: Replace `cornerPreset` with `runDetect`**

Delete the `cornerPreset` function. In its place:

```ts
  /** Find known AI watermarks and pre-paint the mask over them.
   *  Returns the number of marks found. */
  const runDetect = async (auto: boolean): Promise<number> => {
    if (!dims || busyRef.current) return 0
    const t0 = performance.now()
    const imgCtx = imgCanvasRef.current!.getContext('2d', { willReadFrequently: true })!
    const marks = await detectMarks(imgCtx.getImageData(0, 0, dims.w, dims.h))
    track('detect', { found: marks.length, ms: Math.round(performance.now() - t0), auto })
    if (marks.length === 0) return 0
    maskStrokes.current.push({ kind: 'detect', rects: marks.map((m) => m.rect) })
    setMaskActions((n) => n + 1)
    paintDetect(marks.map((m) => m.rect))
    return marks.length
  }
```

Add state for the button/status flow, next to the other `useState` calls:

```ts
  const [detectResult, setDetectResult] = useState<'found' | 'none' | null>(null)
```

Button handler (place after `runDetect`):

```ts
  const detectPressed = async () => {
    if (busy || !dims || cropping) return
    const n = await runDetect(false)
    setDetectResult(n > 0 ? 'found' : 'none')
  }
```

Reset `detectResult` to `null` wherever the mask/stage meaningfully changes so stale messages don't linger: in the decode effect's reset block, in `clearMask`, at the start of `onPointerDown`'s brush path (after the guards), and at the end of `runErase`'s success path (`setDetectResult(null)` alongside `setMaskActions(0)`).

- [ ] **Step 4: Auto-run after image decode**

Add a dedicated effect after the `view`-reset effect (it must live after `runDetect`'s declaration to satisfy this repo's use-before-declare lint):

```ts
  // Auto-detect once per opened image; silent when nothing is found. Skips
  // if the user already started working (brush/crop/erase) before results.
  useEffect(() => {
    if (!dims) return
    let alive = true
    ;(async () => {
      if (maskStrokes.current.length > 0 || eraseCount > 0 || cropping) return
      const n = await runDetect(true)
      if (alive && n > 0) setDetectResult('found')
    })()
    return () => {
      alive = false
    }
    // Re-run only when a new image finishes decoding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims])
```

> `dims` changes on crop/undo too; the `maskStrokes/eraseCount/cropping` guard makes those runs harmless no-ops in practice (post-crop, strokes are empty — a re-scan of the cropped frame is actually desirable; if the mark was cropped out, detection finds nothing and stays silent).

`runDetect` paints only if the editor is still alive: add an `alive`-style guard by checking inside `runDetect` after the `await`:

```ts
    // (inside runDetect, immediately after `const marks = await ...`)
    if (!imgCanvasRef.current) return 0
```

- [ ] **Step 5: Button + status text**

Replace the `✦ corner` button JSX with:

```tsx
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={detectPressed}
            disabled={busy}
          >
            ✦ detect
          </button>
```

Update the `status` expression: the ready-state hint becomes
`'tap ✦ detect to find the watermark, or brush over anything — then erase'`,
and detect results take priority right after the busy/erased branches. Full replacement of the `status` chain:

```ts
  const status = cropping
    ? 'drag to select the area to keep'
    : busy
    ? 'erasing…'
    : detectResult === 'found'
      ? 'watermark detected — press erase'
      : detectResult === 'none'
        ? 'no watermark detected — brush over it manually'
        : eraseCount > 0
          ? 'erased — brush over anything else, or save your image'
          : model.state === 'error'
            ? 'model unavailable'
            : model.state === 'ready'
              ? 'tap ✦ detect to find the watermark, or brush over anything — then erase'
              : model.pct === null
                ? 'loading model…'
                : model.pct >= 1
                  ? 'compiling model…'
                  : `loading model ${Math.round(model.pct * 100)}%`
```

- [ ] **Step 6: Copy updates in `content.ts`**

- `USE_CASES[0].body` → `'The ✦ sparkle that Gemini, Nano Banana and other generators stamp on images — found and erased automatically.'`
- `STEPS[1].body` → `'Tap ✦ detect and the watermark is found and masked for you — or brush over any object, person or text. Press erase and the model rebuilds the background behind it.'`
- In `FAQ`, the answer containing `'Removing the corner watermark is just the one-tap default.'` → `'Detecting and removing the AI watermark is just the one-tap default.'`

- [ ] **Step 7: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass; no remaining references to `cornerRect`, `paintCornerMask`, `'corner'`, or `cornerPreset` (`grep -n "corner" src/` returns only the copy in comments if any — expect none).

- [ ] **Step 8: End-to-end browser verification**

`npm run dev`, then in the browser:
- Open `docs/samples/Gemini_Generated_Image_pfoe69pfoe69pfoe.png` (drag it in). **Expect:** within ~1s the mask auto-paints over the bottom-right sparkle and status reads "watermark detected — press erase". Press erase → sparkle removed cleanly.
- Undo once → the detect mask stroke is removed (replayed empty).
- Press `✦ detect` on a clean image → status "no watermark detected — brush over it manually", nothing painted.
- Crop away the corner containing the sparkle → after apply, auto re-scan stays silent (no false paint).
- Brush immediately after opening an image (before auto-detect finishes, if reproducible) → no detect stroke appears afterwards.
- Console: no errors.

- [ ] **Step 9: Commit and push**

```bash
git add src/components/Editor.tsx src/lib/content.ts
git commit -m "Replace corner preset with real watermark auto-detection

✦ detect finds the Gemini/Nano-Banana sparkle anywhere in the frame
(template matching on edge maps + brightness gate) and pre-paints the
mask; runs automatically on image open, silent on a miss. Landing copy
updated; hardcoded corner preset removed."
git push origin main
```

---

## Self-Review

**1. Spec coverage:** detectMarks contract + pipeline (Task 1); registry with gemini-sparkle, astroid draw (Task 1); precision-biased calibration incl. real sample (Task 2, with recorded metrics); stroke kind/button/auto-run/status/analytics/corner removal (Task 3 Steps 1–5); copy updates (Task 3 Step 6); error handling — `detectMarks` never throws (Task 1 try/catch), stale results guarded (Task 3 Step 4); verification incl. perf budget (Task 2 Step 5, Task 3 Step 8). v2 seam untouched — the editor only knows `detectMarks`.

**2. Placeholder scan:** Task 2's commit message contains `<fill in>` — explicitly instructed to replace with measured numbers before committing; the harness snippets are complete and runnable. No TBDs elsewhere.

**3. Type consistency:** `DetectedMark.rect: Rect` consumed as `m.rect` in Task 3; `DETECT_TUNING` referenced only in Task 1/2; `paintDetect(rects: Rect[])` matches `{ kind: 'detect'; rects: Rect[] }`; `runDetect(auto: boolean): Promise<number>` matches both call sites; `detectResult` state written in Steps 3–4, read in Step 5.

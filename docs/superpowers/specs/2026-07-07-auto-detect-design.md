# Auto-detect watermarks (v1: engineered CV) — design

## Summary

Replace the hardcoded bottom-right `✦ corner` preset with real detection: find
known AI watermarks **anywhere in the frame** and pre-paint the erase mask over
them. v1 is detection we fully own — multi-scale template matching on edge
maps — with zero model download and no license exposure. A permissively-trained
neural detector is the planned v2 behind the same button (see "Staging" below).

Decisions locked during brainstorming:

- **Sourcing:** staged — engineered CV now, ML later. All ready-made watermark
  localizers (YOLOv8/YOLO11 fine-tunes) are AGPL-3.0, which conflicts with the
  monetization plan, and they were trained on stock-photo watermarks so they
  likely miss the Gemini ✦ anyway.
- **Trigger UX:** auto-run once per image open (silent on miss) + a manual
  `✦ detect` toolbar button (reports on miss).
- **Miss behavior:** never paint a guess. Button-press miss shows "no watermark
  detected — brush over it manually". The corner-preset guess disappears.

## Architecture

### `src/lib/detect.ts` (new, pure)

```ts
export type DetectedMark = {
  rect: Rect          // natural-image coords, padded ~20% beyond the glyph
  score: number       // match confidence [0, 1]
  templateId: string  // registry entry that matched, e.g. 'gemini-sparkle'
}

export async function detectMarks(image: ImageData): Promise<DetectedMark[]>
```

No knowledge of the editor, canvases, or React. `Rect` is imported from
`@/lib/inpaint` (the shared shape).

Pipeline inside `detectMarks`:

1. **Downscale** the input to a search image of ≤768px on the long side
   (bilinear, via OffscreenCanvas or a scratch canvas; luminance only).
2. **Edge-energy map**: Sobel gradient magnitude over the luminance plane.
   Matching on edges (not raw pixels) makes detection invariant to the
   watermark's light/dark polarity and tolerant of semi-transparency.
3. **Multi-scale template sweep**: for each registry entry and each scale in
   its range, render the template's edge map and slide it over the search
   image — coarse stride first (~1/4 template size), then refine the top
   candidates at stride 1. Score = normalized cross-correlation (NCC) of edge
   maps, zero-mean, so flat regions can't fake a match.
4. **Threshold + NMS**: keep candidates above the entry's acceptance
   threshold; merge overlapping hits (IoU > 0.3) keeping the best score.
5. **Map back** to natural coordinates, pad each rect by 20% per side, clamp
   to the image. Return sorted by score.

Between scales the function `await`s a macrotask so a slow phone never jams
the main thread; total budget ~100–300ms worst case. No worker, no wasm, no
allocation beyond the transient search planes (≤768² floats ≈ 2.3MB, freed on
return) — well inside the mobile memory policy.

### Template registry

```ts
type Template = {
  id: string
  // Renders the glyph's alpha silhouette at `size` px (square) — a canvas the
  // matcher converts to an edge map.
  draw: (size: number) => ImageData
  // Glyph size range as a fraction of min(imageW, imageH).
  scaleRange: [number, number]
  // NCC acceptance threshold, calibrated per template.
  threshold: number
}
```

v1 ships **one entry**: `gemini-sparkle` — the Gemini / Nano Banana 4-point
star, drawn programmatically (four curved-edge points, the exact proportions
taken from real samples during calibration), `scaleRange` ≈ [0.035, 0.07].
The registry is a flat array; adding Meta's "Imagined with AI" pill or other
marks later is additive and requires no matcher changes.

### Calibration & precision bias

The acceptance threshold is tuned so that **clean images produce zero false
positives** even at the cost of some misses: a miss costs the user one brush
stroke; a false paint costs trust. Calibration procedure (part of
verification, not shipped code): composite the drawn glyph onto a set of
photos at random positions/scales/opacities (0.4–1.0) → require ≥90% hit rate;
run on the same photos without the glyph → require 0 hits. If a real
Gemini/Nano-Banana sample is available in the repo, validate the drawn glyph's
proportions against it and adjust `draw` before tuning the threshold.

## Editor integration (`src/components/Editor.tsx`)

- **Stroke kind**: `MaskStroke` gains `{ kind: 'detect'; rects: Rect[] }`.
  Painting draws a rounded rect over each (same visual as the old corner
  mask); `strokesBBox` unions all rects; `replayMask` replays it. The old
  `'corner'` kind, `cornerRect`, and `paintCornerMask` are **removed** (strokes
  are session-only, so no compatibility concern).
- **Button**: `✦ corner` becomes `✦ detect`, same toolbar position, disabled
  while `busy || cropping`. On tap: run `detectMarks` on the current working
  canvas; if found → push the `detect` stroke, paint, status
  **"watermark detected — press erase"** (or "found N marks — press erase"
  when N > 1); if none → status **"no watermark detected — brush over it
  manually"**. Re-tapping re-runs (idempotent enough: a second identical
  stroke is harmless and undo-able).
- **Auto-run**: once per image, kicked off right after decode succeeds. Results
  apply **only if** the editor is still on the same image and the user hasn't
  painted, cropped, or erased in the meantime (`maskStrokes` empty,
  `eraseCount === 0`, `!cropping`, alive-guard). Silent when nothing is found.
  While detection runs there is no spinner — it's background work.
- **Status line**: the ready-state hint text changes from
  "tap ✦ corner for the watermark, …" to
  **"tap ✦ detect to find the watermark, or brush over anything — then erase"**.
- **Analytics**: `track('detect', { found: n, ms, auto: boolean })` on every
  run. (`corner-preset` event disappears with the button.)

## Copy updates (`src/lib/content.ts`)

- `STEPS[1].body`: "Tap the corner preset…" → "Tap ✦ detect and the watermark
  is found and masked for you — or brush over any object, person or text.
  Press erase and the model rebuilds the background."
- `USE_CASES[0].body` and the FAQ answer mentioning "corner watermark…
  one-tap default" get matching rewording (detection finds the mark wherever
  it sits, not just the corner).

## Error handling

- `detectMarks` never throws to the caller: internal failures resolve to `[]`
  (and `console.error` in dev). A detection failure therefore degrades to
  exactly the old manual-brush experience.
- Auto-run results arriving after the user replaced the image are dropped via
  the decode effect's alive-guard pattern.

## Staging (v2, out of scope here)

The same `detectMarks` contract is the seam for the neural upgrade: a
permissively-licensed architecture (NanoDet/PicoDet, Apache-2.0) fine-tuned on
the public visible-watermark dataset plus synthetic AI-mark composites,
exported to ONNX and run through the existing onnxruntime-web setup (wasm-only
on WebKit per the platform constraints). Nothing in the editor changes when
that lands.

## Out of scope

- Neural/ML detection (v2, above).
- Generic full-frame overlay/text-watermark detection (the anomaly scan) —
  revisited with v2; v1 detects registry glyphs only.
- Invisible watermarks (SynthID) — explicitly not a goal (see FAQ).
- Auto-erase after detection (user always reviews the painted mask first).
- Video.

## Verification

No test runner exists; verification runs in the browser harness against the
dev server:

1. **Synthetic recall**: composite the drawn ✦ onto ≥3 different photos at
   random position/scale/opacity → `detectMarks` hits ≥90%, each rect covering
   the glyph.
2. **Precision**: the same photos, no glyph → 0 detections.
3. **End-to-end**: open a composited image → auto-run paints the mask → erase
   removes the mark; button re-run works; miss path shows the right status.
4. **Perf**: detection completes < 500ms on a 4096px-class image in the dev
   browser (headroom over the phone budget).
5. `npx tsc --noEmit && npm run lint && npm run build` all pass.

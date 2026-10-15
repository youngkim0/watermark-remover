# Adjust (sharpen/blur, brightness) and rotate/flip — design

Date: 2026-10-15
Status: approved in brainstorming; implemented directly at the user's request
(no separate plan document).

## Problem

Users asked for 선명/흐리게 (sharpen/blur), 밝게/어둡게 (brighten/darken) and
rotation. The editor can erase, cut, caption and decorate, but cannot fix a
sideways photo or a dull one.

## Decisions taken in brainstorming

- **Whole-image sliders**, not a local brush. One `sharp` slider (−100 blur …
  +100 sharpen) and one `light` slider (−100 dark … +100 bright).
- **Rotation is 90° steps plus horizontal/vertical flip.** No free-angle
  straightening — lossless, no empty corners, no auto-crop.
- **Adjustments are non-destructive, rendered with WebGL2** (option 1 of
  three; CPU-worker and bake-on-apply were rejected — the first is slow at
  14MP on a phone, the second needs a 56MB snapshot per undo and degrades on
  re-adjust).
- **One `adjust` toolbar button** opens a panel with ↺ ↻ ⇋ ⇵, the two
  sliders, `reset` and `done`.

## Adjust: math

`Adjust = { sharp, light }`, both integers in −100..100; `{0,0}` is neutral.

- `sharp < 0` — Gaussian blur, σ = longSide/150 · (|s|/100)^1.5 (≈27px max on
  a 4096px image; resolution-relative so small and large photos blur alike;
  the 1.5 power gives the low end finer control).
- `sharp > 0` — unsharp mask, `src + 1.5·(s/100)·(src − blur)`, blur σ =
  max(1, longSide/2000).
- `light` — sRGB gamma, `out = in^γ`, γ = 2^(−light/100). Black and white stay
  put and only midtones move, so a bright sky never clips. (Worth overriding
  if a stronger "exposure" feel is wanted.)

## Adjust: rendering

`src/lib/adjustRenderer.ts` — WebGL2, two passes: horizontal Gaussian into an
RGBA8 framebuffer texture, then vertical Gaussian + unsharp/blur combine +
gamma onto the canvas. Taps use the linear-sampling trick (≤64 bilinear
fetches per side). σ < 0.3 skips the blur passes. Premultiplied throughout,
gamma applied to un-premultiplied colour.

The GL canvas sits directly above `imgCanvas` and below the text/glitter
overlays, so overlays are never adjusted and "compare" still shows the raw
original. It is visible only while the adjustment is non-neutral; at neutral
its textures are deleted and the canvas shrunk to 1×1, so the default path
is byte-for-byte today's editor.

- Erase/detect always read the raw `imgCanvas` — the inpainting model never
  sees an adjusted image.
- Any change to the working pixels (open, erase, undo, crop, rotate) bumps an
  `imgVersion` counter; the renderer re-uploads the whole plane when the
  version moves.
- Export renders at full resolution and `drawImage`s the GL canvas into the
  scratch canvas synchronously in the same task, then composites overlays.
- WebGL2 missing, texture too large, or context lost → sliders disabled with
  "adjust unavailable"; rotation keeps working. Restored context re-uploads.

Cost: up to three extra GPU planes, only while non-neutral. Blurs with
σ ≥ 8 run the intermediate plane at half resolution (a quarter of its memory;
worst pixel 5.5/255 off a full-res Gaussian at the threshold, less above it).
Measured on macOS WebKit with a 12MP photo (phys_footprint): WebContent +40MB;
GPU process +115MB for brightness alone, ~+180–270MB with blur/sharpen, back to
+54MB after reset. The export's composited scratch canvas is zeroed after
`toBlob` — left to GC, each save stacked ~100MB in the GPU process.

## Rotate / flip

`src/lib/orient.ts` — `OrientOp = 'cw' | 'ccw' | 'flipH' | 'flipV'` with pure
mappings for dims, points, rects, `ImageData` and canvases (`drawImage` under
an exact integer transform). One op transforms, together:

- working + original canvases;
- mask strokes (vectors; replayed) — so a fresh auto-detect mask does not
  block rotating;
- every erase-undo patch in history (position and pixels) and the overlay
  items those entries would restore;
- live text and glitter anchors. Overlay items move with the photo but keep
  their own look: text stays upright and readable, sparkles keep their angle.

Rotation does not re-run auto-detect, and resets zoom to fit. Net
orientation is tracked as a 2×2 integer matrix so four quarter turns count as
"no edit".

## Undo

`eraseHistory` becomes `history` of `erase | orient | adjust` entries.

- `orient` undo applies the inverse op to everything above.
- `adjust` is pushed once when the panel closes with changed values, holding
  the previous values.
- The crop-undo snapshot is untouched: history entries made after a crop are
  popped (and their rotations reversed) before crop undo is reached, so the
  snapshot's coordinate frame is always the current one.

## Verification

No test runner; drive Chrome over CDP and compare canvas hashes:
4× `cw` and 2× `flipH` return the original hash; erase → rotate → undo ×2
returns the original; neutral export is unchanged; `light` moves midtones but
keeps 0 and 255.

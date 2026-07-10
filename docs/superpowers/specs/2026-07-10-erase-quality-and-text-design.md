# Erase quality + Add Text — design

Date: 2026-07-10
Status: implemented in this session; written for async review (user was away,
so design decisions below were made autonomously and are called out explicitly).

## Problem

1. **Eraser leaves visible marks.** The MI-GAN patch is pasted back with a
   hard per-pixel mask, the mask is never dilated, and multi-mark erases run
   through one giant crop window. Three concrete artifacts:
   - *Seams*: hard boundary between inpainted and original pixels.
   - *Halos*: anti-aliased watermark fringe just outside the brushed mask
     survives, leaving a ghost outline of the erased mark.
   - *Blur*: the pipeline model resizes its input to 512px internally. When
     the mask bbox spans distant regions (detect finds marks in two corners),
     `computeCrop` returns a window far larger than 512, so the model works at
     a fraction of native resolution and the pasted patch is visibly soft.
2. **No text tool.** Users cannot add a caption/text (incl. Korean) to the
   cleaned image.

## Decisions (would normally be clarifying questions)

- **Keep MI-GAN**, don't swap models. LaMa-class models are 20–100x larger;
  the product bet (instant, on-device, mobile-safe) is already encoded all
  over this repo. The artifacts above are compositing/windowing bugs, fixable
  in post-processing for ~zero cost.
- **Text stays a live overlay until export** (not baked into the bitmap on
  "apply"), so it remains editable all session; it is composited only into
  the downloaded PNG. Erase/undo history and text are independent.
- **WYSIWYG via canvas**: text is drawn on a dedicated overlay canvas with the
  exact same drawing routine used at export time, so preview == output.
  DOM is used only for selection chrome and hit-testing.
- **Fonts via `next/font/google`** (build-time download, self-hosted, so the
  site's `COEP: require-corp` header is a non-issue and no runtime Google
  request happens). All offered fonts cover Hangul + Latin so Korean always
  works regardless of style choice: Noto Sans KR (400/700), Noto Serif KR
  (400/700), Black Han Sans, Do Hyeon, Jua, Nanum Pen Script.
  `preload: false` — font files load lazily, only when the text tool is used.

## Part 1 — erase quality (`src/lib/inpaint.ts`, `Editor.runErase`)

### 1a. Mask dilation
Before running the model, dilate the binary mask by a radius that lands ≈3px
at model resolution: `r = max(3, round(3 * maxSide(crop)/512))`. The model
then regenerates the watermark's anti-aliased fringe instead of leaving it.
Separable box dilation (two passes), O(n) per pixel.

### 1b. Feathered paste-back
Replace the hard per-pixel paste with an alpha blend:
- `alphaRaw = boxBlur(dilatedMask, r)` → smooth 0..1 ramp
- `alpha = 1` wherever the *user* mask is set (guaranteed full replacement),
  `alphaRaw` in the dilated ring outside it
- `out = alpha·model + (1−alpha)·original`

The ring is a few px wide; on 512 crops the model returns the input outside
the mask so the blend is lossless there, and on larger crops a 3–6px soft
ring is far less visible than a hard seam.

### 1c. Cluster splitting
In `runErase`, group mask strokes into spatial clusters (bbox per brush
stroke / per detect rect, expanded by `CROP_PAD`, merged transitively while
overlapping). Run one inpaint per cluster, sequentially. Two marks in
opposite corners now each get a tight ~512 window at near-native resolution
instead of sharing one 4096-wide window.

Undo consequence: an erase action can now produce several patches, so
`eraseHistory` becomes `InpaintPatch[][]` (one group per erase; restored in
reverse order). Byte cap logic unchanged, counted across groups. `CropUndo`
carries the grouped type.

## Part 2 — Add Text

### Data model (`src/lib/text.ts`)
```ts
type TextItem = {
  id: number
  text: string            // may contain newlines
  x: number; y: number    // natural px, center anchor
  size: number            // natural px font size
  fontId: FontId
  weight: 400 | 700
  color: string           // hex
}
```
Shared helpers: `drawTextItems(ctx, items)` (used by both the preview canvas
and export), `measureTextItem(item)` → bbox for hit-testing/selection ring,
`loadFontsFor(items)` → `document.fonts.load(...)` per item incl. its actual
text (so Korean unicode-range slices load on demand).

### Fonts (`src/lib/fonts.ts`)
`next/font/google` instances at module scope with `preload: false`, exported
as `TEXT_FONTS: { id, label, family, weights }[]` where `family` is the
generated `style.fontFamily`, usable in both CSS and `ctx.font`.

### Editor integration
- New `tool` state: `'erase' | 'text'`. Toolbar gains a `text` button; in
  text mode the toolbar swaps to text controls (like the crop mode swap).
- Text mode UI: overlay canvas (same natural dims) above the mask canvas
  draws all items; pointerdown hit-tests bboxes → select/drag; tap empty
  canvas does nothing; "add text" button inserts a centered item with
  placeholder text and selects it.
- Selected item: amber dashed selection ring (DOM, sized from measured bbox /
  displayScale), and toolbar controls: content textarea, font picker, size
  slider, color swatches, bold toggle (Noto families only), delete.
- Managed by a `useTextTool` hook to keep `Editor.tsx` from ballooning.
- Interactions with existing features:
  - `hasEdit` includes `items.length > 0` (enables save).
  - Compare hides the text canvas (compares against original photo).
  - Crop: applying a crop translates item anchors; items whose anchor falls
    outside the kept rect are dropped. Crop-undo restores the item list.
  - Erasing is unaffected; mask canvas ignores pointers while in text mode.
  - cmd+Z does not manage text (v1 limitation); items are edited/deleted
    directly.
- Export: `download()` composites `imgCanvas` + `drawTextItems` onto a
  scratch canvas after `loadFontsFor(items)` resolves.

## Testing
- `tsc --noEmit`, eslint, `next build` (repo rule).
- Headless browser pass on the real Gemini sample: erase the detected mark,
  verify no visible seam/halo (pixel-diff the boundary band vs background
  statistics), and add Korean text ("안녕하세요") in each font, verify it
  renders into the saved PNG.

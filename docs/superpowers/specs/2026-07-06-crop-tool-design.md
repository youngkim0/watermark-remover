# Crop ("cut") tool — design

## Summary

Add a crop tool to the editor, labeled `cut` in the toolbar (Korean: 자르기).
The user drags a rectangle over the image and commits it, trimming the
canvas to that region. This is a plain rectangular crop — not subject
extraction / background removal.

## Toolbar & entry point

New button `cut` is inserted between `✦ corner` and `undo`:

```
[brush] [✦ corner] [cut] [undo] [clear] [erase] | [compare] [save png] [new image]
```

- Disabled while `busy`, or while `maskActions > 0` (unerased brush strokes
  present). Cropping is only allowed against a clean mask, so there's no
  window where mask-stroke coordinates and canvas coordinates could
  disagree.
- Clicking it enters **crop mode**.

## Crop mode

While `cropping` is true:

- The bottom toolbar row is replaced with exactly two buttons: `cancel`
  (neutral `ctrl` style) and `apply` (amber primary style, matching
  `erase`'s treatment).
- The status line reads something like "drag to select the area to keep".
- Brush painting is suppressed: `onPointerDown`/`onPointerMove` on the mask
  canvas early-return when `cropping` is true, and the brush cursor overlay
  is hidden.
- A new component, `CropOverlay`, renders the draggable selection rectangle
  on top of the image.

### `CropOverlay` component

New file: `src/components/CropOverlay.tsx`. Self-contained — it knows
nothing about canvases, undo, or the rest of the editor.

```ts
function CropOverlay(props: {
  natural: { w: number; h: number }   // dims.w / dims.h
  display: { w: number; h: number }   // fit.w / fit.h — the CSS box it fills
  onChange: (rect: Rect) => void
}): JSX.Element
```

`Rect` (`{ x, y, w, h }`) is the existing type from `@/lib/inpaint`, already
used elsewhere in `Editor.tsx` for the erase crop-window. Reused here
rather than defining a second shape.

- Internal state is the selection rectangle in **display** (CSS) pixel
  space, initialized to cover the full box (`{x:0, y:0, w:display.w,
  h:display.h}`).
- 8 drag handles (4 corners + 4 edges), plus dragging inside the rect to
  move it. Implemented with pointer events + `setPointerCapture`, matching
  the existing mask-painting interaction pattern in `Editor.tsx`.
- Dimmed exterior via the standard crop-mask CSS trick: the selection div
  gets `box-shadow: 0 0 0 9999px rgba(0,0,0,0.6)` inside an `overflow:
  hidden` container sized to `display.w x display.h`. Amber (`var(--amber)`)
  border, matching the app's accent color used elsewhere (brush cursor,
  corner mask).
- Minimum selection size: 32×32 **natural** pixels, converted to display
  pixels via `scale = natural.w / display.w` for clamping during drag.
- On every change (drag move, resize, and once on mount) it calls
  `onChange` with the rect converted to **natural** image coordinates,
  rounded to integers and clamped to `[0, natural.w] x [0, natural.h]`.
- No internal apply/cancel UI — the parent (`Editor`) owns those buttons
  and reads the latest rect from a ref it fills via `onChange`, avoiding
  re-renders during drag:

```tsx
const cropRectRef = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 })
// ...
{cropping && (
  <CropOverlay
    natural={dims}
    display={fit}
    onChange={(r) => { cropRectRef.current = r }}
  />
)}
```

## Applying a crop

New function `applyCrop(rect: Rect)` in `Editor.tsx`, called by the
toolbar's `apply` button with `cropRectRef.current`.

1. Guard: no-op if `busy || !dims || maskActions !== 0`.
2. Decide whether to keep an undo snapshot: compute
   `bytes = dims.w * dims.h * 4 * 2` (full image + orig planes at the
   *pre-crop* size). If `bytes <= MAX_UNDO_BYTES` (the existing 96MB
   constant), capture both full planes via `getImageData` and build:
   ```ts
   type CropUndo = {
     dims: Dims
     image: ImageData
     orig: ImageData
     eraseCountBefore: number
   }
   ```
   Store it in `cropUndo.current` (a ref), replacing any prior value (only
   one crop-undo slot is ever kept — a second crop discards the first
   snapshot rather than nesting). Mirror its presence into a state boolean
   `cropUndoAvailable` for reactive button enablement.
   If it doesn't fit, set `cropUndo.current = null` / `cropUndoAvailable =
   false` — this crop is not undoable. (On typical 12MP+ photos, the two
   full planes alone meet or exceed the cap, so undo commonly won't be
   available for large images — this is expected and matches the
   commit-`d121f2b` precedent of not retaining large full-frame pixel data
   on mobile.)
3. Crop each of `imgCanvasRef`, `origCanvasRef` via a scratch canvas +
   `drawImage` (canvas-to-canvas; no `getImageData`/`putImageData` needed
   for this part beyond what step 2 already did): draw the source canvas's
   `rect` region into a same-sized-as-`rect` scratch canvas, then resize the
   real canvas to `rect.w x rect.h` and draw the scratch canvas onto it.
   Resize `maskCanvasRef` to `rect.w x rect.h` (it's already empty per the
   mask-empty gate).
4. Reset `eraseHistory.current = []` and `setEraseCount(0)` (whatever
   erase-undo history existed pre-crop is either preserved implicitly via
   the pixel snapshot in step 2, or gone — its per-patch coordinates are
   meaningless against the new canvas size either way).
5. `setDims({ w: rect.w, h: rect.h })` — the existing fit-recalculation
   effect picks this up automatically.
6. Exit crop mode (`setCropping(false)`), track `track('crop', { w:
   rect.w, h: rect.h })`.

## Undo

`undo()` gains a third fallback tier, tried in order:

1. Pop a mask stroke (existing).
2. Pop an erase patch (existing).
3. **New:** if `cropUndo.current` is set, restore it: resize
   `imgCanvasRef`/`origCanvasRef`/`maskCanvasRef` to `snapshot.dims`,
   `putImageData(snapshot.image, 0, 0)` / `putImageData(snapshot.orig, 0,
   0)`, clear the mask canvas, `setDims(snapshot.dims)`,
   `setEraseCount(snapshot.eraseCountBefore)`, clear `cropUndo.current` /
   `cropUndoAvailable`, `track('undo')`.

Erasing after a crop doesn't touch `cropUndo.current` — it stays valid
until either undone or superseded by another crop, so `undo` naturally
walks back through post-crop erases before reaching the crop boundary.

Combined worst-case retained undo memory: one crop snapshot (≤96MB, by
construction) plus the live post-crop erase-history budget (≤96MB,
existing cap) — bounded, not accumulating across multiple crops, since
only one crop snapshot is ever kept.

## Save / compare gating

Currently gated on `eraseCount > 0`. Generalized to also account for a
crop having been applied, without new state to keep in sync: a new
`originalDims = useRef<Dims | null>(null)` is set once, alongside the
existing `setDims(...)` call in the image-decode effect, to the
just-decoded image's dimensions. It is never touched by `applyCrop` or
`undo`. Derive:

```ts
const hasEdit =
  eraseCount > 0 ||
  (dims !== null &&
    (dims.w !== originalDims.current!.w || dims.h !== originalDims.current!.h))
```

`hasEdit` replaces `eraseCount === 0` in the `compare` and `save png`
button `disabled` checks. This derives correctly across any number of
crop/undo cycles since it compares current `dims` directly rather than
tracking a separate boolean that could drift out of sync.

`undo`'s disabled check becomes: `busy || (maskActions === 0 && eraseCount
=== 0 && !cropUndoAvailable)`.

## Out of scope

- Aspect-ratio presets (free-form drag only).
- Any relationship to watermark/subject removal — this is a plain
  rectangular trim.
- Redo.
- Persisting more than one crop-undo level.

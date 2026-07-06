# Zoom & pan — design

## Summary

Add zoom and pan to the editor so users can magnify the image for precise
brushing on small watermarks, blemishes, and detail. Both desktop and mobile
are first-class:

- **Mobile:** one finger brushes (unchanged); two fingers pinch-zoom and pan.
- **Desktop:** wheel / trackpad-pinch zooms toward the cursor; hold Space and
  drag to pan.
- **Everyone:** a small floating `− 120% + fit` control appears at the image's
  bottom-right only while zoomed in.

Zoom is a pure CSS transform — **no pixel reallocation, zero added memory** —
which is essential given the editor's mobile-memory constraints.

## Architecture

A single view state drives one CSS transform on the existing `fit`-sized image
container `<div>` (the one wrapping the three canvases):

```ts
type View = { zoom: number; panX: number; panY: number }
// applied as: transform: translate(${panX}px, ${panY}px) scale(${zoom})
// transform-origin: 0 0 (top-left) so focal-point math is straightforward
```

Key properties:

- **Memory-free.** The canvases keep their natural-pixel backing store; nothing
  is re-rasterized or re-rendered. Inpainting is unaffected — it always reads
  natural pixels regardless of the on-screen transform.
- **Brushing already works under transform.** `toNatural()` maps pointer →
  image coordinates via the mask canvas's live `getBoundingClientRect()`, which
  reflects the CSS transform. Under `scale(z)` the canvas rect is `z×` larger
  and offset by pan, and the formula `((clientX - rect.left) / rect.width) *
  dims.w` still yields correct natural coordinates. **No change to the erase /
  mask coordinate math is required.**
- **Ref-driven, no re-render during gestures.** The live transform is written
  imperatively to the container's `style.transform` from a `view` ref (matching
  the codebase's ref-driven painting that avoids per-move re-renders). A
  throttled React state holds only the zoom percentage for the readout and a
  boolean for "is zoomed" (controls visibility).

*Rejected alternative:* re-rendering the canvases at a higher device-pixel
ratio for crispness when zoomed. This reallocates full-frame pixel buffers
(tens of MB), directly violating the editor's mobile-memory policy, for a
benefit (sharper-than-source pixels) that doesn't exist — the source image has
no more detail to show. CSS scaling of the existing bitmap is correct.

## Files

- **Create:** `src/lib/useViewTransform.ts` — a hook encapsulating the whole
  view subsystem: the `view` ref + derived state, the transform string, and the
  gesture handlers (wheel, multi-pointer pinch/pan, Space-drag). Keeps the
  already-large `Editor.tsx` from absorbing a second subsystem. Interface:

  ```ts
  function useViewTransform(opts: {
    containerRef: React.RefObject<HTMLDivElement | null>
    // Called when a second pointer starts a pinch mid-stroke, so the editor can
    // cancel the in-progress brush stroke (pop it + replay the mask).
    onPinchStart: () => void
    enabled: boolean // false during crop mode → forces fit and ignores gestures
  }): {
    zoomPct: number            // e.g. 120, for the readout
    isZoomed: boolean          // zoom > 1, drives control visibility
    zoomIn: () => void         // step zoom toward center
    zoomOut: () => void
    fit: () => void            // reset to { zoom: 1, panX: 0, panY: 0 }
    // Multi-pointer handlers the editor forwards from the mask canvas.
    onPointerDown: (e: React.PointerEvent) => boolean // true = gesture consumed the event
    onPointerMove: (e: React.PointerEvent) => boolean
    onPointerUp: (e: React.PointerEvent) => void
    // Wheel handler for the stage.
    onWheel: (e: React.WheelEvent) => void
    // True while a two-finger / space-drag gesture is active (suppress brushing).
    gesturing: boolean
  }
  ```

- **Create:** `src/components/ZoomControls.tsx` — presentational floating
  control. Props: `pct: number`, `onZoomOut`, `onZoomIn`, `onFit`. Renders
  `−  {pct}%  +` and a `fit` reset, styled with the existing `ctrl`/`label`
  classes. Positioned absolutely at the image stage's bottom-right; rendered by
  the editor only when `isZoomed && !cropping`.

- **Modify:** `src/components/Editor.tsx` — instantiate the hook, apply the
  transform to the image container, forward the mask canvas's pointer events
  through the hook first (so two-finger gestures win over brushing), add the
  stage `onWheel`, render `ZoomControls`, and wire the reset triggers.

## Interaction detail

### Mobile (touch)

Pointer events on the mask canvas are the single input surface for both brush
and gesture. The hook tracks active pointers in a `Map<pointerId, {x,y}>`:

- **1 pointer:** the hook's `onPointerDown` returns `false` — the editor's
  normal brush path runs (unchanged).
- **2nd pointer down:** the hook calls `onPinchStart()` (editor cancels the
  in-progress stroke: pop the last mask stroke and replay), captures the initial
  two-finger **distance** and **midpoint**, and returns `true`. `gesturing`
  becomes true; the editor suppresses brushing.
  - On move: `zoom *= currentDistance / startDistance` (clamped), and
    `pan += (currentMidpoint − startMidpoint)`; the focal point is the midpoint
    so the pinch feels anchored under the fingers.
- **Back to <2 pointers:** pinch ends. Brushing does **not** resume until *all*
  pointers lift, so a lingering finger can't paint a stray stroke.

### Desktop

- **Wheel / trackpad-pinch → zoom toward cursor.** `onWheel` zooms by a factor
  derived from `deltaY`, keeping the pixel under the cursor fixed (adjust pan so
  the cursor's image point stays put). `preventDefault()` so the page doesn't
  scroll.
- **Space-drag → pan.** Holding Space sets a "pan-ready" flag (cursor → grab);
  a mouse drag then pans instead of brushing. Releasing Space restores brushing.
  Space is currently unused by the editor, so there's no conflict.

### Floating control (all platforms)

`− {pct}% + fit`, appearing at bottom-right only when `zoom > 1`. `−`/`+` step
zoom by ×1.25 toward the frame center; `fit` resets to `{1, 0, 0}`. It sits
above the canvas (its own pointer events, not forwarded to brushing).

## Limits & clamping

- **Zoom range:** `[1, 8]`. Min is 1 (fit) — there is no zoom-out past fit, as
  the image already fits the frame. Max 8× is enough for pixel-level detail.
- **Focal zoom:** wheel homes on the cursor; pinch homes on the midpoint;
  button/`+`/`−` home on the frame center.
- **Pan clamp:** `panX`/`panY` are clamped every update so the scaled image
  always fully covers the `fit` frame — you cannot drag the image edge inward
  and reveal empty space. At `zoom === 1`, pan is forced to `0`.

## Brush cursor under zoom

The brush-preview circle lives **inside** the transformed container, so the
CSS `scale(zoom)` grows it in lockstep with the actual painted radius — the
preview keeps matching what a stroke will erase. Its position is computed in
**unscaled** container coordinates (client-delta ÷ `zoom`) so that, once the
container scales back up, it lands under the cursor. (Today the cursor is
positioned in raw client-relative pixels; that math moves into the hook /
becomes zoom-aware.)

## Reset triggers

- **New image loaded:** reset view to `{ zoom: 1, panX: 0, panY: 0 }`.
- **Entering crop mode:** reset view to fit and set the hook's `enabled=false`,
  so cropping happens at 1×. `CropOverlay`'s drag math is in display pixels and
  would mismatch under a transform; keeping crop at fit avoids that entirely.
  `ZoomControls` is hidden while cropping. On apply/cancel, view stays at fit.
- **After an erase:** view is **kept** (do not reset) so the user can keep
  working while zoomed in.

## Out of scope

- Double-tap-to-zoom (collides with quick brush dabs on mobile).
- Zoom-aware cropping (crop resets to fit instead).
- Rotate / flip (separate feature).
- Zooming out past fit / minimap / fit-to-selection.

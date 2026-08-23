# Glitter stickers — design

Date: 2026-08-23
Status: approved in brainstorming; not yet implemented.

## Problem

The editor can remove things (erase, cut) and add words (text), but there is
no way to add decorative marks. Users who clean a photo often want to dress it
up — 반짝이 / glitter sparkles are the most-asked-for form of that: a handful of
stars and specks placed by hand over a portrait or a product shot.

## Decisions taken in brainstorming

Four questions were asked; the answers below are the user's, not defaults.

- **Placeable sparkle stickers**, not a scatter brush, not a full-image shimmer
  overlay, not animated output. Each sparkle is a discrete object that can be
  selected, moved, restyled and deleted. Export stays a single PNG.
- **Canvas-drawn parametric shapes**, not bundled SVG/PNG art and not emoji
  glyphs. Zero assets to ship or license, crisp at any export resolution,
  freely tintable, and identical on every platform (emoji are not).
- **Tap the image to drop one.** Pick a shape, then each tap on the photo
  places that sparkle at the tap point. Ten sparkles is ten taps, with no
  round-trip through a menu.
- **Shape + color + size** are the per-sparkle controls. Rotation is
  randomized at placement; opacity and glow are baked into each shape's
  drawing so there is nothing extra to tune before it looks right.
- **Ten shapes** in the palette (the user raised this from four).

Two decisions made while designing, called out because they are the ones most
worth overriding:

- **No blend modes.** Real glitter would read better composited with `screen`
  onto the photo, but the overlay lives on its own canvas, so a blend would
  have to be reproduced by hand at export time and would erase any dark-tinted
  sparkle. Shapes are drawn source-over with a soft radial halo instead:
  WYSIWYG holds for free, and any color works.
- **The tool button is the word `glitter`, with no ✦ glyph.** That glyph
  already means "the watermark we detect and remove" in this toolbar
  (`✦ detect`); it must not also mean "the sparkle you add".

## Architecture

Four pieces, mirroring the text tool so the editor stays one pattern:

| File | Role |
|---|---|
| `src/lib/glitter.ts` (new) | `GlitterItem` type, shape registry, `drawGlitterItems`, `measureGlitterItem`. Pure canvas, no React, no assets. |
| `src/lib/useGlitterTool.ts` (new) | State + pointer interactions: place, hit-test, select, drag, update, delete, crop-shift, restore, remove-covered. |
| `src/components/GlitterControls.tsx` (new) | Toolbar shown while the tool is active. |
| `src/components/Editor.tsx` | Wiring: `tool` union, new canvas layer, export / crop / undo / erase hookups. |

Sparkles stay a **live overlay until export**, exactly as text does — never
baked into the working bitmap — so they remain editable for the whole session
and are independent of the erase/undo history.

### Canvas layering

```
imgCanvas       working photo
textCanvas      text overlay
glitterCanvas   sparkle overlay      ← new
origCanvas      compare plane (hides both overlays while held)
maskCanvas      the single pointer surface
```

Sparkles above text, so a sparkle can sit on a caption. Both overlays below
the compare plane, so "hold to compare" hides everything the user added. The
glitter canvas is `pointer-events-none`; the mask canvas remains the only
event surface and routes to the tool hook, as it already does for text.

## Data model

```ts
export type GlitterShape =
  | 'spark' | 'star' | 'twinkle' | 'burst' | 'dust'
  | 'bokeh' | 'ring' | 'diamond' | 'heart' | 'snowflake'

export type GlitterItem = {
  id: number
  shape: GlitterShape
  x: number        // natural px, center anchor
  y: number
  size: number     // natural px, bounding diameter
  color: string
  rotation: number // radians, randomized at placement
  seed: number     // stable RNG for multi-element shapes
}
```

`seed` is load-bearing: `dust` is a scatter of specks whose positions must be
identical on every redraw and in the export. Shapes draw through a small
seeded PRNG (`mulberry32`-style), never `Math.random()` at draw time.

`measureGlitterItem` returns the `size × size` square centered on the anchor.
It is rotation-invariant because every shape is drawn inside its inscribed
circle, which keeps hit-testing, the selection ring and erase-coverage all
trivial and consistent with each other.

## The ten shapes

Each is a `draw(ctx, item)` in a `Record<GlitterShape, ...>` registry, drawn
in a saved/restored context translated to `(x, y)`, rotated by `rotation`, and
scaled so the shape is authored once in a unit circle of radius 1.

| # | id | Reads as | Construction |
|---|---|---|---|
| 1 | `spark` | ✦ classic 4-point sparkle | 4 tips joined by quadratic curves pinched toward the center |
| 2 | `star` | ★ 5-point star | 10 alternating radii, straight edges |
| 3 | `twinkle` | ✳ fine 6-point needle star | 3 crossed tapered spikes |
| 4 | `burst` | lens-flare cross | 2 long + 2 short tapered rays over a bright gradient core |
| 5 | `dust` | scattered glitter specks | seeded scatter of ~9 dots + 2 mini sparks |
| 6 | `bokeh` | soft out-of-focus light orb | translucent disc with a brighter rim ring |
| 7 | `ring` | thin halo ring | stroked circle with alpha falling off around the sweep |
| 8 | `diamond` | gem | rhombus plus a lighter facet triangle |
| 9 | `heart` | glossy heart | two arcs with a small specular highlight |
| 10 | `snowflake` | ❄ six-arm crystal | 6 arms, two branch pairs each |

Every shape paints a soft radial halo first — `color` at ~0.35 alpha fading to
transparent at `size/2` — then the mark itself at full alpha. That is what
makes a flat fill read as light rather than as a pasted icon.

Rotation is randomized over a full turn at placement so a cluster never looks
stamped; the symmetric shapes absorb that range without looking wrong.

Adding, removing or swapping a shape is one function plus one union member and
nothing else. Likely alternates if any of the ten underperform: `confetti`
(curled ribbon strip), `flower` (5 petals), `bubble`, `plus` (fine 4-ray cross).

## Interaction

Entry: a `glitter` button in the erase toolbar, beside `text`. Guarded like
`text` — disabled while busy or cropping. Unlike the text tool, entering does
**not** auto-place a first item; the tool is a placement mode, and the status
line says so (`tap the image to add sparkle`).

Pointer-down on the image while the tool is active:

1. **Hits an existing sparkle** — topmost first, with the same `HIT_PAD = 12`
   tap padding the text tool uses → select it and arm a drag.
2. **Hits nothing** → place a new sparkle at that point with the current
   shape/color/size, select it, and arm the drag immediately. A tap places;
   a tap-and-slide places then nudges, in one gesture.

There is deliberately no "tap empty space to deselect" — every empty tap
places. Selection exists only to say which sparkle the controls drive, and a
freshly placed sparkle is always selected, so nothing needs deselecting.
`done` exits the tool.

Drag clamps the anchor to the image bounds, as the text tool does.

### Sticky defaults

The hook holds a `draft: { shape, color, size }`. Toolbar edits apply to the
selected sparkle *and* update the draft; with nothing selected they update the
draft only. The next tap uses the draft. Setting gold-medium once and tapping
ten times is ten taps.

Initial draft: `shape: 'spark'`, `color: '#ffffff'`,
`size: clamp(round(dims.w / 10), 24, 400)`.

### Undo

Tap-to-place makes a stray tap easy, far more so than the text tool's explicit
`+ add`, so glitter carries its own undo:

- `GlitterControls` gets an `undo` button that removes the most recently
  placed sparkle (the items array is already placement-ordered).
- ⌘/ctrl+Z maps to it while the tool is active. The keyboard handler in
  `Editor` currently returns early for any non-erase tool; that branch gains a
  glitter case rather than being widened.

This covers the dominant mistake. Restyle/move/delete are not undoable, same
as in the text tool.

## Controls layout

Ten shape buttons cannot share one row with a color strip, a size slider,
undo, delete and done on a phone. `GlitterControls` renders two rows:

- **Row 1 — shape palette.** A horizontally-scrollable strip of ten 32px
  targets with snap scrolling; the active shape is ringed in `--amber`.
  Each palette icon is **rendered by `drawGlitterItems` itself** onto a small
  canvas rather than being a hand-drawn icon, so the palette is a guaranteed
  preview of what a tap produces and adding a shape never means also authoring
  an icon. Icons draw at a fixed rotation (not random) so the palette is
  stable across re-renders.
- **Row 2 — controls.** Color swatches plus a native color input (same markup
  as `TextControls`, but its own glitter-appropriate list — white, gold
  `--amber`, pink, silver-blue, black — defined in `GlitterControls`; the two
  toolbars each keep their own palette rather than sharing a constant), a size
  slider, then `undo`, `delete`, `done`.

Size slider range: `12` to `max(400, round(dims.w / 3))`, so the ceiling stays
useful on a 4K photo without making the slider useless on a small one.

`delete` is disabled with nothing selected; `undo` is disabled with no items.

## Integration edges

- **Export.** `download()` already composites text onto a scratch canvas;
  glitter draws after text (sparkles on top). No fonts to await, so no new
  async in that path. `hasEdit` gains `glitterTool.items.length > 0`, which is
  what enables `save png` and `compare`.
- **Crop.** `glitterTool.applyCrop(rect)` shifts anchors into the kept rect
  and drops sparkles whose anchor was cut away — the text rule verbatim. The
  crop-undo snapshot carries `glitterItems` beside `textItems`, restored on
  undo. The glitter canvas is resized with the others in both `applyCrop` and
  the crop-undo branch.
- **Brushing over a sparkle.** Same contract as text (commit `d7b59d8`): a
  sparkle the user brushed over is deleted, and the strokes that deleted it
  are dropped from the mask so **the photo underneath is not inpainted** —
  inpainting there would only smear untouched pixels. This requires the same
  coverage heuristic (majority of the bbox, or the majority of a central core
  band for thin swipes) already written inline in `runErase` for text.
  Rather than paste it twice, lift it into one helper over `{ id, bbox }`
  pairs and run both overlays through it. `EraseUndo` gains a
  `glitters: GlitterItem[]` field so an undo restores erased sparkles the way
  it already restores erased text.
- **Analytics.** `track('download')` gains a `glitters` count beside
  `erases`/`texts`; `track('erase')` gains `glitters` beside `texts`;
  a `glitter-open` event mirrors `text-open`.
- **Reset on new image.** The image-load effect in `Editor` sizes
  `textCanvasRef` alongside the other canvases and calls `resetText()` before
  `setTool('erase')`; the glitter canvas joins that ref list and
  `glitterTool.reset()` is called there too.

## Refactor included in this work

The overlay-removal logic in `runErase` (remove covered items, then drop the
strokes that removed them, then replay the mask) is currently text-specific
and inline. It becomes a shared helper taking `{ id, bbox }[]` and returning
the ids to remove plus the surviving strokes, used by both overlays. This is
the only refactor in scope — nothing unrelated gets touched.

## Testing

No test runner in this repo, so verification is the existing bar: `tsc`,
`eslint`, `next build` all clean, then a manual browser pass covering:

- Each of the ten shapes places, renders, and matches its palette icon.
- Tap places at the tap point; tap-and-slide places then drags; drag clamps at
  the image edges.
- Shape/color/size edit the selected sparkle and stick as the next-tap default.
- `undo` removes the last placed sparkle; ⌘Z does the same in-tool.
- A sparkle survives a crop when inside the kept rect and disappears when its
  anchor is cut away; crop-undo restores it.
- Brushing over a sparkle and pressing `erase` deletes the sparkle and leaves
  the photo beneath it untouched (no inpaint smear); `undo` restores it.
- `hold to compare` hides sparkles; the exported PNG matches the preview
  pixel-for-pixel at full resolution.
- A 4K photo with ~30 sparkles stays responsive on mobile Safari, and the
  overlay redraw does not retain full-frame pixel data (the repo's standing
  mobile-memory constraint).

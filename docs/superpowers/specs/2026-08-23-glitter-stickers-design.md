# Glitter stickers — design

Date: 2026-08-23; rendering rebuilt 2026-08-24
Status: shipped. The first version shipped on 2026-08-23 and read as flat
stickers; the 2026-08-24 rebuild redraws every shape as light, adds six more
procedural shapes and three photographic plates, and is recorded inline below
rather than as a separate document.

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

- **No blend modes on the overlay.** Originally chosen to keep preview and
  export identical; re-tested on 2026-08-24 by shipping a `screen` version and
  looking at it, and confirmed for a better reason: screening is
  indistinguishable from normal compositing on a dark photo and destroys the
  sparkle on a light one. Light accumulates *within* an item instead.
- **The tool button is the word `glitter`, with no ✦ glyph.** That glyph
  already means "the watermark we detect and remove" in this toolbar
  (`✦ detect`); it must not also mean "the sparkle you add".

## Architecture

Four pieces, mirroring the text tool so the editor stays one pattern:

| File | Role |
|---|---|
| `src/lib/glitter.ts` | `GlitterItem` type, palette order, `drawGlitterItems`, `measureGlitterItem`, plate loading. |
| `src/lib/glitterShapes.ts` | The nineteen drawers and their shared light primitives (bloom, core, spike, chromatic spike, luminous body). |
| `src/lib/glitterPlates.ts` | Loading, luminance-to-alpha conversion, tinting and caching of the photographic plates. |
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

## The shapes (rebuilt 2026-08-24)

The first version drew each shape as a flat tinted fill with a soft halo, and
it read as a sticker pasted on the photo — which is what it was. The rebuild
draws every sparkle as **light**, in layers that accumulate with `'lighter'`
inside the item:

```
shade   a whisper of dark under everything, source-over
halo    wide, low-alpha, tinted
bloom   tighter, brighter, tinted, steep (inverse-square-ish) falloff
body    the shape's geometry, near-white
core    small, pure white, the hottest point
```

Three details carry most of the difference:

- **The core is white whatever the tint.** A real specular highlight clips to
  white and only its falloff is coloured. A uniformly tinted mark cannot look
  like light.
- **Spikes are lens-shaped and chromatically split** — each drawn three times,
  warm and cool offset by a few percent of its length. That fringing is why a
  highlight reads as glass rather than vinyl.
- **A tap places a constellation, not a mark.** Shapes with `satellites` draw
  an anchor plus seeded companions at reduced brightness. It is still one
  `GlitterItem` — one thing to select, drag and delete — and the satellites
  stay inside radius 1 so the footprint contract holds.

### Compositing: not a screen blend

Screening the overlay onto the photo was tried and rejected. On a dark photo
it is indistinguishable from compositing normally; on a light one it washes
every sparkle away, and most photos have bright areas. The overlay composites
source-over; the light quality comes from the layered shading, not the blend.

The same reasoning drives the **shade** layer: a screen cannot draw brighter
than white, so on a pale photo a white highlight has no contrast to work with.
A very faint dark radial under each sparkle — far below drop-shadow strength,
and invisible on a dark frame — is what lets it read at all. The default tint
is a saturated gold for the same reason.

### Roster

Sixteen procedural, three photographic. Palette order runs points of light
first, then objects, then the wide and atmospheric ones.

| id | Reads as |
|---|---|
| `spark` | four long chromatic spikes + four short diagonals |
| `glint` | fine star-filter cross on a hard little light |
| `burst` | cinematic lens star: long vertical, short horizontal |
| `twinkle` | six fine needles of uneven length |
| `star` | ★ five-point star, shaded as a luminous body |
| `prism` | refraction — spikes split into spectral colours |
| `dust` | glitter powder: 26 grains, each with its own bloom |
| `shimmer` | a field of fine crossed glints |
| `comet` | bright head with a tapering dust trail |
| `flare` | anamorphic streak with a hot core |
| `bokeh` | defocused hexagonal aperture, hollow, bright rim |
| `halo` | pure glow, no geometry |
| `ring` | luminous ring with a glint where it catches the light |
| `diamond` | gem with a refraction spike |
| `heart` | glossy heart |
| `snowflake` | ❄ six-arm crystal with a tinted glow along the arms |
| `grain` | **plate** — photographed glitter powder |
| `lensflare` | **plate** — photographed anamorphic flare |
| `bokehPlate` | **plate** — photographed defocused bokeh, keeps its own colours |

### The photographic plates

Three plates generated with Higgsfield and shipped in `public/glitter/`
(~207KB total). Procedural shapes can imitate the geometry of light but not
its texture; these carry grain a canvas path cannot.

They are lit subjects on pure black, so `glitterPlates.ts` converts luminance
to alpha at build time — otherwise the dark half of the frame composites as an
opaque box around the sparkle. RGB is renormalised so a dim pixel goes
transparent rather than muddy. The result is tinted, feathered to a disc, and
cached per (plate, colour); `bokehPlate` takes only a light tint wash because
its multi-coloured spill is the point of it.

Because a plate draws nothing until its image is in memory, `loadPlatesFor`
mirrors the text tool's font contract: the overlay redraws when a plate lands,
and the exporter awaits it, so a saved PNG can never contain a half-loaded
sparkle.

Rotation is randomized at placement, bounded per shape. The eight symmetric
shapes take a full turn — a 5-point star's full turn is visually only ±36°, a
6-arm snowflake's ±30°, and dust, bokeh, halo and ring look identical at any
angle. `heart` (no rotational symmetry), `diamond` (2-fold), and the two
streaks (`flare`, `lensflare`, which read as lens artifacts only near level)
get a small tilt instead.

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

Selecting an existing sparkle also adopts its style into the draft. The
toolbar always displays the selected sparkle's style, so without that the two
drift apart: select a small heart, and the palette would read "heart" while
the next tap still placed the large star the draft was holding. The rule that
keeps it honest is that the toolbar and the next tap must never disagree.

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
- **A failed erase.** `runErase` deletes covered overlay items and drops their
  strokes *before* the model runs, but only records the undo entry *after*.
  If the model throws in between — mobile OOM is a live failure mode here —
  those sparkles and captions would be gone with nothing to restore them. So
  the catch path rolls back what the attempt had already applied: the patches
  it painted, in reverse, and the overlay items it removed. A `committed`
  flag, set when the undo entry is pushed, marks the point where ownership of
  the reversal passes to `undo`, so the two can never both fire.
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

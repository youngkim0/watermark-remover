# Background removal (with refine brush) — design

Date: 2026-10-21
Status: decided in brainstorming; awaiting builder check / plan.

## Intent

Users want to cut the subject out of a photo, both **people** (portraits, to
composite elsewhere) and **objects** (product shots on a plain background).
Unmark's wedge is that everything runs on the device, free and unlimited
(see `monetization-strategy` memory), so background removal must do the same:
a browser model, no server, and no per-image cost.

About half the users are on phones, often iPhones. The iOS/WebKit constraints in
`ios-webkit-onnx-constraints` memory apply in full.

## Goals

- One-tap background removal for people and objects.
- The user chooses the result: **transparent** or a **solid background**
  (white, black, or any colour). The choice can change at any time.
- A **refine brush** with two modes, **keep** (bring back what the model cut)
  and **remove** (cut what it left). It fixes the known model misses, such as
  an object held in a hand that gets cut off, or a white object on a white
  background that turns partly transparent.
- Works on iPhone (WebKit, wasm EP only) without killing the tab.

## Non-goals

- No AI background *replacement* (scenes, blur-the-background, generated
  backdrops). A solid colour or transparency only.
- No click-to-select / SAM-style interactive segmentation. The refine brush
  is the manual fallback.
- No batch processing. That is a separate, later feature.
- No new language. The UI copy is English only, like the rest of the site.

## Anti-goals (failure even if it "works")

- Loading the model when the editor opens. People who never press the button
  must not download 47MB.
- A non-commercial or copyleft model or library. Unmark plans paid tiers and
  B2B licensing, so BRIA RMBG (non-commercial) and `@imgly/background-removal`
  (AGPL) are out.
- Holding the background model and MI-GAN at peak memory at the same time on
  iPhone, or keeping full-frame pixel snapshots per refine stroke.
- Baking the cutout into the working pixels in a way that stops erase, text,
  glitter, mosaic or adjust from working afterwards.

## Model — decided (spike 2026-10-21)

- **IS-Net general-use** (DIS, Apache-2.0), from rembg's
  `isnet-general-use.onnx` (178.6MB fp32).
- **Quantized by us** with onnxruntime `quantize_dynamic`, `QuantType.QUInt8`,
  after `quant_pre_process(skip_symbolic_shape=True)`. These convs are excluded
  from quantization and stay fp32: `/conv_in/*`, every conv under the
  `stage1d` and `stage2d` stages, and every `side*` conv. Result: **46.8MB**.
  - Plain full int8 (45.3MB) left visible speckle in the background on 3 of
    8 test images. `per_channel=True` changed nothing.
  - The chosen variant matched fp32 to ≤0.6% mean alpha difference on 7 of 8
    test images, and 1.8% on the hardest (white headphones on white).
- **Pre-processing:** square-stretch the image to 1024×1024 (no letterbox), RGB
  float32, `x / max(x) − 0.5`, NCHW, std 1.
- **Post-processing:** take **only the first output** (`session.run(feeds,
  [outputNames[0]])`). Fetching all 6 side outputs cost +120MB of garbage per
  run on WebKit, peaking at 1.8GB before GC. Then min–max normalise, upscale to
  the working resolution (bilinear), and clean the alpha with a smoothstep:
  ≤0.06 → 0, ≥0.80 → 1, smoothstep in between.
- **Measured (WebKit via Playwright, Mac, 8 wasm threads):** session create
  ≈0.4s, run ≈1.9s at 1024², WebContent footprint flat at ≈870MB across 10 runs
  (isolated page, without MI-GAN loaded). iPhone is expected to be 2–3× slower.
- The quantization script goes in the repo (e.g. `scripts/quantize-isnet.py`)
  so the model can be rebuilt. The `.onnx` is committed under `public/models/`
  like `migan_pipeline_v2.onnx` (plain git, no LFS).
- **Attribution:** IS-Net is Apache-2.0. Ship its license/notice alongside the
  model and credit it where the footer credits mi-gan / onnx runtime.

## Runtime

- Reuse the same ort loading rules as `src/lib/inpaint.ts`. On WebKit that
  means plain `onnxruntime-web`, pinned non-JSEP `ort-wasm-simd-threaded`
  wasm, and never the WebGPU EP. On other browsers WebGPU is allowed only if
  the builder verifies its output matches wasm; otherwise use wasm everywhere.
- Download on first use, with progress shown in the status line, the same way
  the editor already reports MI-GAN loading. The browser HTTP cache is what
  makes the second use fast. A Cache Storage or IndexedDB layer is allowed but
  not required.
- **Release the session after each removal** (`session.release()`) so its
  arena doesn't sit next to MI-GAN's. Re-creating it costs ≈0.4s plus the
  cached fetch.
- **MI-GAN is released before IS-Net runs** *(builder-check call)*. Today
  `inpaint.ts` preloads MI-GAN when the editor opens and keeps the session
  forever. Add a release path there: background removal tears MI-GAN down
  first, and the next erase re-creates it lazily (cached fetch, with the
  existing "loading model…" status). Only one model session ever exists at a
  time. Peak budget during a removal, on a 12MP image in WebKit: the
  WebContent footprint stays at or below the editor's existing post-erase
  level (≈960MB) plus 300MB.

## Behaviour

### Entry

- A new toolbar button, **`remove bg`**, opens the background tool, a panel
  like `adjust`, `text` or `glitter` with its own controls and `done`.
- On the first open per image, removal runs automatically. While it runs, the
  status line shows the progress and the rest of the editor is busy, as during
  an erase.
- If the model fails to load or run, show an error and leave the image
  untouched.

### Model input *(builder-check call)*

- The model sees the **working canvas**: after erases and mosaic, before
  adjust. That is the same plane erase and detect read, and it needs no GL
  readback.
- If the source image already has transparency, it is flattened on white for
  the model. The final alpha is **source alpha × cutout alpha**, so a cutout
  never makes transparent pixels opaque.

### One-shot removal *(builder-check call)*

- Removal runs when the tool opens and **no cutout exists**: on the first
  open, after `turn off`, or after undoing the removal. While a cutout exists,
  reopening the tool goes straight to refining, and nothing re-runs.
- There is no "re-run" control. To start over, turn the cutout off and
  reopen the tool.
- Alpha cleanup (the smoothstep) is applied once, to the model output. Brush
  strokes write alpha directly afterwards. No "brushed pixels" plane is kept.

### The cutout layer (non-destructive)

- *(Revised 2026-10-22 for memory.)* The alpha is stored at **≤2048px on
  the long side** (the model only sees 1024², so a full-resolution alpha adds
  cost, not detail). It is shown as a **fill overlay** at the same capped size,
  CSS-scaled over the unchanged photo/adjust layers. No full-resolution cut-view
  composite exists, and export scales the alpha up once. Measured in WebKit on
  11.2MP: retained GPU-process memory fell from +168MB to +30MB.
- The result is an **alpha plane** (originally: at the working resolution), kept separately
  from the working pixels. The working canvas keeps full RGB everywhere, so
  erase, detect, mosaic and adjust keep operating on real pixels, and the
  cutout is applied at display and export.
- Layering, bottom to top:
  1. the background (checkerboard for transparent, or the solid colour)
  2. the photo (with adjust) masked by the alpha
  3. text and glitter overlays (never cut)
  4. the compare plane (shows the untouched original, no cutout)
- The alpha plane follows rotate/flip and crop like `origCanvas` does. The crop
  undo snapshot must include it.
- **The builder decides how to render the masked photo** (a 2D composite
  canvas, CSS mask, folding it into the GL adjust pass, …). It must stay
  correct with adjust active, under zoom/pan, and without per-frame full-res
  `getImageData`.

### Background choice

- Swatches: **transparent** (default), **white**, **black**, and a **colour
  picker**. Switching is instant and doesn't re-run the model.
- A colour change is not its own undo step. The background in effect when the
  tool's `done` is pressed is what gets kept.

### Refine brush

- Two modes in the tool panel: **keep** and **remove**, plus a brush-size
  slider (shared range with the erase brush, 8–96 display px).
- A stroke paints alpha 255 (keep) or 0 (remove) under the brush, with a soft
  antialiased edge.
- While the tool is open, removed areas show the photo as a faint ghost
  (~25% opacity) over the background, so the user can see what there is to
  bring back. After `done`, removed areas are fully gone.
- Brush cursor preview, `[` `]` resize, pinch-zoom and pan behave as in
  erase/mosaic.

### Undo / redo

- History entries (and their redo counterparts), using the existing
  undo/redo machinery from PR #2:
  - **removal**: the alpha plane comes into existence. Undo returns to "no
    cutout".
  - **refine stroke**: one entry per stroke, holding the stroke's bounding-box
    patch of the previous alpha, never the full plane.
  - **turn off**: a `remove bg off` / `reset` control in the panel drops the
    cutout and is undoable.
- Alpha bytes count toward the existing `MAX_UNDO_BYTES` cap, like erase and
  mosaic patches.
- Alpha patches are re-expressed through rotate/flip like the existing patch
  entries (`orientEntry`).
- *(builder-check call)* The removal and every refine stroke go **straight
  into the global history** when they happen, the way mosaic strokes do. Undo
  and redo work inside the panel. There is no cancel: `done` only closes the
  panel, and leaving it never discards work.

### Export

- The composite follows the same layering as the display, minus the compare
  plane, with the solid background filled first when one is chosen.
- **Transparent + PNG/WebP** keeps the alpha. **Transparent + JPG** saves on
  white, and the save panel says so ("jpg has no transparency — saved on
  white").
- Copy to clipboard (PNG) keeps transparency.
- `hasEdit` is true while a cutout exists.

## Analytics (Umami, names and counts only)

`bg-open`, `bg-remove` {ms, ep}, `bg-error`, `bg-refine` {strokes} on
`done`, `bg-background` {kind: transparent|white|black|custom} on `done`.

## Constraints and checks the builder must satisfy

- `npx tsc --noEmit && npm run lint && npm run build` pass. Mind the
  react-hooks lint rules in `react-hooks-lint-constraints` memory.
- End-to-end headless-Chrome CDP verification, as in
  `headless-browser-verification` memory, covering:
  - removal produces partial alpha
  - keep/remove strokes change alpha only under the brush
  - undo/redo of removal and of a stroke restore alpha by hash
  - rotate and crop keep the alpha aligned
  - PNG export has transparency; JPG export is on white
- **WebKit memory check on a 12MP image**, with MI-GAN loaded, as in
  `ios-webkit-onnx-constraints` memory. Report the WebContent and GPU
  footprint after open, after removal, and after five refine strokes, and
  confirm memory returns to roughly the pre-removal baseline plus the alpha
  plane once the session is released. If it doesn't, stop and report instead
  of shipping.

## Left to the builder

- How to render the masked photo (see above).
- Whether to try WebGPU on non-WebKit browsers.
- The exact panel layout, swatch styling and the ghost opacity. Match the
  existing tool panels.
- Where the license notice lives (a `NOTICE` beside the model, a footer
  credit, or both).
- Whether to stack the branch on `mosaic-brush` (PR #3) or wait for
  #2 and #3 to merge.

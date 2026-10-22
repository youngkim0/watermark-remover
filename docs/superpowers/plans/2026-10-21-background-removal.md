# Background Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `remove bg` tool that cuts out people or objects on-device. The result is a non-destructive alpha layer with a transparent or solid background, and a keep/remove refine brush.

**Architecture:**
- A quantized IS-Net model runs through a shared onnxruntime loader. MI-GAN is released first, so only one session ever exists.
- The result is a full-resolution **alpha canvas** kept beside the working pixels.
- A 2D **cut view** canvas shows `photo (with adjust) × alpha` over a background div. Export composites the same layers.
- Removal, turn-off and refine strokes are entries in the existing history/redo stacks.

**Tech Stack:** Next.js 16 / React 19 client component, onnxruntime-web (wasm; WebGPU only off WebKit), Canvas 2D, Python 3 + onnxruntime for the offline quantization, `node --test` (Node 22, `--experimental-strip-types`) for pure helpers.

**Spec:** `docs/superpowers/specs/2026-10-21-background-removal-design.md`

## Global Constraints

- Branch `bg-removal`, created from `mosaic-brush` (PR #3). The PR targets `mosaic-brush`.
- License: model IS-Net general-use, Apache-2.0. No BRIA RMBG, no `@imgly/background-removal`.
- Model file `public/models/isnet_general_q.onnx`, ≈46.8MB, plain git (no LFS).
- Never download the model until the tool is first opened.
- WebKit: plain `onnxruntime-web`, `wasmPaths` pinned to `/ort/ort-wasm-simd-threaded.{wasm,mjs}`, never the WebGPU EP.
- Only one ort session at a time: release MI-GAN before IS-Net, and release IS-Net after each run.
- Peak WebContent footprint during a removal on a 12MP image (WebKit): ≤ the post-erase level (≈960MB) + 300MB.
- Inference: 1024×1024 square stretch; input `x/max(x) − 0.5` NCHW float32; fetch only `outputNames[0]`; min–max normalise; smoothstep cleanup lo 0.06 / hi 0.80.
- UI copy is English, lowercase, in the existing label style.
- Every commit passes `npx tsc --noEmit && npm run lint && npm run build`. The only allowed lint output is the pre-existing `replayMask` exhaustive-deps warning.
- No full-frame `getImageData` per frame or per pointer move.
- Analytics events, names and counts only: `bg-open`, `bg-remove` {ms, ep}, `bg-error`, `bg-refine` {strokes}, `bg-background` {kind}.

## Review Focus

1. **Remove bg on an image that already has transparency** (a PNG logo). Originally transparent pixels must stay transparent in view and export, and the model must see the image flattened on white. → Task 2 test `toModelInput flattens transparent pixels on white`; Task 6 CDP check on a transparent PNG.
2. **Erase right after a removal.** MI-GAN was released, so the next erase must reload it (status shows "loading model…") and still succeed. → Task 1 CDP check `erase after releaseModel`.
3. **Adjust active while a cutout exists.** The cut view must show the adjusted photo, not the raw one, and must not go blank when the GL canvas is cleared after a frame. → Task 4 CDP check: hash of cut view changes with brightness.
4. **Rotate or crop after refining.** The alpha must stay registered to the subject, and undoing a stroke after a rotate must restore the right pixels. → Task 5 CDP checks.
5. **Model download fails or the session throws.** Show the error, leave no cutout and no history entry, and keep the editor usable; MI-GAN must still reload on the next erase. → Task 3 CDP check with the model URL blocked.

---

### Task 1: Model asset + shared ort loader + MI-GAN release

**Files:**
- Create: `scripts/quantize-isnet.py`, `public/models/isnet_general_q.onnx`, `public/models/NOTICE-isnet.txt`, `src/lib/ort.ts`
- Modify: `src/lib/inpaint.ts` (move loader code out; add release), `src/app/page.tsx` (footer credit `mi-gan · is-net · onnx runtime · webgpu/wasm`)

**Interfaces:**
- Produces, in `src/lib/ort.ts`:
  - `isWebKitEngine(): boolean`
  - `type LoadProgress = { stage: 'download'; loaded: number; total: number } | { stage: 'compile' }`
  - `createOrtSession(url: string, opts: { onProgress?: (p: LoadProgress) => void; allowWebGPU: boolean }): Promise<{ session: InferenceSession; ort: OrtModule; ep: 'webgpu' | 'wasm' }>`
- Produces, in `src/lib/inpaint.ts`: `releaseModel(): Promise<void>`. It releases the MI-GAN session if one exists and clears `sessionPromise`. The next `inpaint()` or `preloadModel()` re-creates the session.

- [ ] **Step 1: Write `scripts/quantize-isnet.py`.** Usage: `python scripts/quantize-isnet.py <isnet-general-use.onnx> <out.onnx>`. It runs `quant_pre_process(skip_symbolic_shape=True)`, then `quantize_dynamic(weight_type=QuantType.QUInt8, nodes_to_exclude=…)`. The excluded set is every `Conv` node whose name starts with `/conv_in/`, `/stage1d/`, `/stage2d/` or `/side`. The script prints the output size. The header comment holds the source URL `https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx` and the spike numbers.
- [ ] **Step 2: Build the model.** Run the script in a throwaway venv (`onnxruntime onnx numpy`).
  Expected: `public/models/isnet_general_q.onnx` ≈ 46.8MB (46,830,571 bytes in the spike).
- [ ] **Step 3: Write `public/models/NOTICE-isnet.txt`.** Contents: the IS-Net (DIS) Apache-2.0 notice, copyright of Xuebin Qin et al., a link to https://github.com/xuebinqin/DIS, and the note "quantized by Unmark".
- [ ] **Step 4: Extract `src/lib/ort.ts`.** Move `loadOrt`, `isWebKitEngine`, `hasWebGPU` and the progress-reporting fetch out of `inpaint.ts` unchanged in behaviour. `createOrtSession` sets `wasmPaths`/`numThreads` exactly as `createSession` does today. It tries WebGPU only when `allowWebGPU && await hasWebGPU()`, and falls back to wasm. `inpaint.ts` calls `createOrtSession(MODEL_URL, { onProgress, allowWebGPU: true })` and keeps its own `track('model-ep')`.
- [ ] **Step 5: Add `releaseModel()` to `inpaint.ts`.** It awaits the pending `sessionPromise` (ignoring rejection), calls `session.release()`, and sets `sessionPromise = null`.
- [ ] **Step 6: Verify (CDP, headless Chrome on `next start`).** Open the Gemini sample, wait for "watermark detected", call `releaseModel()` through a dev hook, then press erase.
  - For the dev hook, expose `window.__unmarkReleaseModel = releaseModel` only when `process.env.NODE_ENV !== 'production'`, or drive the hook through a test build. Remove it before committing if it isn't needed later.
  - Expected: the erase completes and the pixel hash changes.
  - Also run the PR #2 CDP suite (undo/redo/export/paste). All 22 checks still pass.
- [ ] **Step 7: Commit.**

```bash
git add scripts/quantize-isnet.py public/models/isnet_general_q.onnx public/models/NOTICE-isnet.txt src/lib/ort.ts src/lib/inpaint.ts src/app/page.tsx
git commit -m "Add quantized IS-Net model, shared ort loader, and MI-GAN release"
```

### Task 2: Pure matte helpers (unit-tested)

**Files:**
- Create: `src/lib/matte.ts` (no imports, so `node --experimental-strip-types` can load it), `src/lib/matte.test.ts`
- Modify: `package.json`, adding the script `"test": "node --experimental-strip-types --test src/lib/*.test.ts"`

**Interfaces — Produces (`src/lib/matte.ts`):**
- `export const MATTE_SIZE = 1024`
- `export function toModelInput(rgba: Uint8ClampedArray): Float32Array`. The input is RGBA at 1024×1024. Each pixel is flattened over white by its alpha, the max is taken over the RGB channels, the result is `v/max − 0.5`, and the layout is planar `[R…, G…, B…]` (length 3·1024²).
- `export function cleanAlpha(a: number): number`. Input and output are 0..1: ≤0.06 → 0, ≥0.80 → 1, smoothstep `t²(3−2t)` between.
- `export function outputToAlpha(out: Float32Array): Uint8ClampedArray`. Min–max normalise, then `cleanAlpha`, then ×255 rounded. Returns RGBA at 1024² with RGB = 255 and A = alpha, ready for `putImageData`. A constant input (max = min) gives all-zero alpha.
- `export type AlphaPlane = { w: number; h: number; data: Uint8Array }` (one byte per pixel)
- `export function orientPlane(p: AlphaPlane, op: 'cw' | 'ccw' | 'flipH' | 'flipV'): AlphaPlane`. Same index mapping as `orientImageData` in `src/lib/orient.ts`.

- [ ] **Step 1: Write the failing tests** in `src/lib/matte.test.ts` (`node:test` + `node:assert/strict`):
  - `cleanAlpha` maps `0.06→0`, `0.8→1`, `0.43→0.5` (±1e-9), `0→0`, `1→1`, and is monotonic over 0..1 in 0.01 steps.
  - `toModelInput` on an all-white opaque image gives every value `0.5`. A pixel (255,0,0,255) in a white image gives R plane `0.5`, G and B `-0.5`.
  - **`toModelInput flattens transparent pixels on white`**: a fully transparent black pixel produces `0.5` in all three planes.
  - `outputToAlpha` on `[0, 0.5, 1, …]` gives alpha bytes `[0, 128 ±1, 255, …]` with RGB 255. On a constant input it gives alpha all 0.
  - `orientPlane` on a 3×2 plane `[1,2,3,4,5,6]`: `cw` → 2×3 `[4,1,5,2,6,3]`; `flipH` → `[3,2,1,6,5,4]`. `cw` then `ccw` round-trips.
- [ ] **Step 2: Run it.** `npm test`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement `src/lib/matte.ts`.**
- [ ] **Step 4: Run it.** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit.**

```bash
git add src/lib/matte.ts src/lib/matte.test.ts package.json
git commit -m "Add matte helpers: model input, alpha cleanup, plane orientation"
```

### Task 3: `removeBackground` runner

**Files:**
- Create: `src/lib/bgRemove.ts`

**Interfaces:**
- Consumes: `createOrtSession` (Task 1), `releaseModel` (Task 1), `toModelInput`, `outputToAlpha`, `MATTE_SIZE` (Task 2)
- Produces:
  - `export type BgProgress = LoadProgress | { stage: 'run' }`
  - `export async function removeBackground(source: HTMLCanvasElement, onProgress?: (p: BgProgress) => void): Promise<{ alpha: HTMLCanvasElement; ep: 'webgpu' | 'wasm'; ms: number }>`
  - `alpha` is a new canvas at `source.width × source.height`. Its pixels are white, and its alpha channel is the cutout.

- [ ] **Step 1: Implement.** The steps, in order:
  1. `await releaseModel()`
  2. `createOrtSession('/models/isnet_general_q.onnx', { onProgress, allowWebGPU: true })`
  3. Draw `source` into a 1024² scratch canvas with smoothing on, `getImageData`, then `toModelInput`
  4. `session.run({ [inputNames[0]]: tensor }, [outputNames[0]])`
  5. `outputToAlpha`, then `putImageData` into the 1024² scratch
  6. `drawImage`-upscale it into the returned `alpha` canvas
  7. Zero the scratch canvas, then `session.release()` in `finally` (also on error)

  `ms` measures steps 3–6. If the WebGPU output is non-finite, or differs from a known-good wasm result on the test image (checked in Step 2), set `allowWebGPU: false` and note it in the commit.
- [ ] **Step 2: Verify (CDP).** On a page that imports nothing else, or via the Task 4 UI once it exists, run `removeBackground` on the Gemini sample and on Pexels 5965592 (person).
  - Expected: the alpha canvas has both alpha 0 and alpha 255 pixels.
  - Expected: the mean alpha of the person image is between 0.15 and 0.6.
  - Also block `/models/isnet_general_q.onnx` with `Fetch.enable` + `failRequest` and confirm the promise rejects without leaking a session. The next `inpaint` still works.
- [ ] **Step 3: Commit.** `git add src/lib/bgRemove.ts && git commit -m "Add on-device background removal runner (IS-Net)"`

### Task 4: Cutout layer, background tool panel, export

**Files:**
- Create: `src/components/BgControls.tsx`
- Modify: `src/components/Editor.tsx`, `src/lib/adjustRenderer.ts`, `src/components/ExportControls.tsx`

**Interfaces:**
- Consumes: `removeBackground` (Task 3)
- Produces:
  - In `Editor.tsx`: `alphaCanvasRef` (offscreen, never in the DOM), `cutCanvasRef` (display), state `cutout: boolean`, `bg: BgFill`
  - `type BgFill = { kind: 'transparent' } | { kind: 'color'; color: string }`. White and black are `color` presets `#ffffff` and `#000000`.
  - `HistoryEntry` gains `{ kind: 'cutout-on' }` and `{ kind: 'cutout-off'; alpha: AlphaPlane }`
  - `RedoEntry` gains `{ kind: 'cutout-on'; alpha: AlphaPlane }` and `{ kind: 'cutout-off' }`
  - `entryBytes` counts `alpha.data.byteLength`
- Produces, in `AdjustRenderer`: `setAfterRender(fn: ((gl: HTMLCanvasElement) => void) | null): void`. `fn` is called synchronously at the end of every successful `renderNow`, while the GL canvas is still readable.
- Produces, `BgControls` props:
  - `{ bg: BgFill; mode: 'keep' | 'remove'; brush: number; busy: boolean; canUndo: boolean; canRedo: boolean`
  - `onBg(b: BgFill): void; onMode(m): void; onBrush(v: number): void; onUndo(): void; onRedo(): void; onTurnOff(): void; onDone(): void }`
  - Swatches: `transparent` (checker glyph), `white`, `black`, and `<input type="color">` (aria-label "Background color"). Mode buttons `keep` / `remove`. Brush slider 8–96. Then `undo`, `redo`, `turn off`, `done`. The mode buttons, brush, undo, redo and turn off take effect in Task 5. They are rendered now but disabled while `!cutout`.
- Produces, `ExportControls` new prop: `note?: string`. It renders as a faint label under the format row.

- [ ] **Step 1: Write the cut-view renderer.** `renderCutView(dirty?: Rect)` in `Editor.tsx`:
  1. `ctx.clearRect` (dirty rect or the full frame)
  2. Draw the source: when adjust is visible, draw the GL canvas via the `setAfterRender` callback path; otherwise draw `imgCanvas`
  3. `globalCompositeOperation = 'destination-in'` and draw `alphaCanvas`

  When adjust is active and the change comes from alpha (not GL), call `rendererRef.current.renderNow(...)`. The after-render hook then composites in the same task.
- [ ] **Step 2: Wire the DOM layers inside the image box.** Bottom to top:
  1. The background div: CSS checkerboard for transparent, or the colour
  2. `imgCanvas`: opacity 1 without a cutout; 0.25 while the bg tool is open with a cutout (the ghost); 0 otherwise
  3. `adjustCanvas`: hidden while a cutout exists, because its pixels go through the cut view
  4. `cutCanvas`: visible only while a cutout exists
  5. text, then glitter, then `origCanvas` (compare), then `maskCanvas`, unchanged
- [ ] **Step 3: Add the tool.**
  - A toolbar button `remove bg`, placed after `mosaic`.
  - `enterBg()`: `track('bg-open')`. If there is no cutout, run removal with busy state and status `removing background…`, plus download progress `loading background model N%`. On success:
    1. Copy the result into `alphaCanvas`
    2. `cutout = true`
    3. Push history `{ kind: 'cutout-on' }`, then `clearRedo()`
    4. `renderCutView()`
    5. `track('bg-remove', { ms, ep })`

    On failure: `setError('Background removal failed — try a smaller image or reload.')`, `track('bg-error')`, no history entry, and the tool stays open.
  - `exitBg()`: `track('bg-background', { kind })`, where kind is `transparent | white | black | custom`, then back to the erase tool.
  - After a removal, MI-GAN is gone. Set `model` state to `{ state: 'loading', pct: null }` lazily on the next erase (the inpaint progress callback already updates it).
- [ ] **Step 4: Turn off and undo/redo.**
  - `turnOff()`: snapshot the alpha into an `AlphaPlane` (its alpha channel only), push `{ kind: 'cutout-off', alpha }`, `clearRedo()`, `cutout = false`.
  - Undo of `cutout-on`: snapshot the plane into redo `{ kind: 'cutout-on', alpha }`, then `cutout = false`.
  - Redo of `cutout-on`: write the plane back into `alphaCanvas` (white + alpha), then `cutout = true`.
  - Undo of `cutout-off`: restore the plane. Redo of `cutout-off`: turn off again.
  - `hasEdit` includes `cutout`.
- [ ] **Step 5: Export.** In `renderExport`, when `cutout`:
  1. Fill the background first: the colour if chosen, white for JPG when transparent, otherwise leave it clear
  2. Composite the photo (adjusted if active) masked by `alphaCanvas` through a second scratch canvas
  3. Draw text and glitter

  Pass `note="jpg has no transparency — saved on white"` to `ExportControls` when `cutout && bg.kind === 'transparent' && format === 'jpeg'`.
- [ ] **Step 6: Verify (CDP).**
  - Open the person sample and press `remove bg`. Expected: the export panel's PNG decodes with some alpha-0 and some alpha-255 pixels (read back via an `<img>` and a canvas in the page).
  - Choose `white`, then save JPG. Expected: the corner pixel is ≈(255,255,255).
  - Set brightness +60 in adjust. Expected: the `cutCanvas` hash differs from before, and no blank frame (the hash of a non-empty region stays non-zero) after 2 RAFs.
  - Undo. Expected: the cutout is gone and `imgCanvas` is visible. Redo. Expected: the cutout is back with an identical alpha hash.
  - Turn off, then undo. Expected: the cutout is back.
  - Erase after removal. Expected: it succeeds (reloads MI-GAN).
- [ ] **Step 7: Commit.** `git add src/components/BgControls.tsx src/components/Editor.tsx src/lib/adjustRenderer.ts src/components/ExportControls.tsx && git commit -m "Add remove-bg tool: cutout layer, background fill, export"`

### Task 5: Refine brush + rotate/crop integration

**Files:**
- Modify: `src/components/Editor.tsx`

**Interfaces:**
- Consumes: `orientPlane`, `AlphaPlane` (Task 2); the Task 4 layers, entries and `BgControls` callbacks
- Produces:
  - `HistoryEntry` and `RedoEntry` gain `{ kind: 'cutout-stroke'; patch: ImageData; x: number; y: number }`. The patch is the alpha canvas bbox before the stroke (history) or after it (redo).
  - `CropUndo` gains `alpha: AlphaPlane | null`

- [ ] **Step 1: Refine strokes.**
  - With the bg tool open and `cutout` true, the pointer path works like mosaic: a live stroke recorded in a ref, using the same width computation and brush cursor.
  - Each segment paints onto `alphaCanvas` directly: `keep` uses `source-over` white, `remove` uses `destination-out`, with round caps (canvas antialiasing gives the soft edge).
  - Each segment calls `renderCutView(segmentBBox)`.
  - At stroke start, snapshot the alpha canvas `getImageData` of the region the stroke can touch. Grow it as the stroke grows, or take the whole stroke's bbox at the end from a copy kept at start. **Builder's choice, but no full-frame copy per stroke.**
  - On release, push `cutout-stroke` and `clearRedo()`. Count strokes for `bg-refine` on `done`.
  - Undo/redo of `cutout-stroke`: swap the patch with the current pixels, then `renderCutView(rect)`.
  - `[`, `]`, ⌘Z and ⌘⇧Z work in this tool, as in mosaic.
- [ ] **Step 2: Rotate/flip.**
  - `applyOrient` also runs `orientCanvas(alphaCanvasRef.current, op)` and re-renders the cut view.
  - `orientEntry` maps `cutout-stroke` (orient the patch ImageData and its rect, like `orientPatch`) and `cutout-off` (`orientPlane`).
  - Redo entries are not re-oriented (LIFO validity, as today).
- [ ] **Step 3: Crop.**
  - `cropTo` crops `alphaCanvas` with the other planes.
  - The crop-undo snapshot stores `alpha` (when a cutout exists) and counts its bytes toward `MAX_UNDO_BYTES`.
  - Crop undo restores the alpha and the `cutout` flag.
- [ ] **Step 4: Verify (CDP).**
  - Remove bg on the person image. A `remove` stroke across the face sets alpha to 0 under the stroke only: the alpha hash outside the stroke bbox is unchanged.
  - A `keep` stroke over the background sets alpha to 255 there.
  - Undo the stroke. Expected: the alpha hash equals the pre-stroke value. Redo. Expected: it equals the post-stroke value.
  - Rotate cw, then undo the stroke. Expected: it equals the rotated pre-stroke hash.
  - Crop, then undo the crop. Expected: the alpha hash equals the pre-crop value.
  - Compare (hold `c`). Expected: the original shows without the cutout.
- [ ] **Step 5: Commit.** `git add src/components/Editor.tsx && git commit -m "Add keep/remove refine brush; keep the cutout aligned through rotate and crop"`

### Task 6: WebKit memory gate, copy, PR

**Files:**
- Modify: `src/lib/content.ts` (one `USE_CASES` entry, `{ title: 'Backgrounds', body: 'Cut out a person or product in one tap — keep it transparent or drop it on white.' }`, and the FAQ sentence on formats mentioning transparent PNG)

- [ ] **Step 1: Run the WebKit memory check** with Python Playwright WebKit and `footprint -f bytes -p <pid>`, following `ios-webkit-onnx-constraints` memory, on a 12MP test photo. Record the WebContent and GPU footprint at each point:
  1. after open
  2. after one erase
  3. during and after remove bg
  4. after 5 refine strokes
  5. after a following erase

  Gate: the peak during removal is ≤ the post-erase level + 300MB, and the level after removal is ≤ the post-erase level + 150MB (the alpha plane plus the cut view). If the gate fails, stop and report the numbers; don't ship.
- [ ] **Step 2: Run the transparent-PNG check (Review Focus 1).** Open a PNG with a transparent border and remove bg. Expected: the exported PNG border stays alpha 0.
- [ ] **Step 3: Update `content.ts`,** then run `npx tsc --noEmit && npm run lint && npm run build && npm test`.
- [ ] **Step 4: Commit and open the PR** against `mosaic-brush`. The body lists the memory numbers and the CDP checks.

```bash
git add src/lib/content.ts
git commit -m "Mention background removal on the landing page"
git push -u origin bg-removal
gh pr create --base mosaic-brush --title "Add on-device background removal with refine brush"
```

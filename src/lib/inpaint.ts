// MI-GAN inpainting on-device via onnxruntime-web.
// Model contract (migan_pipeline_v2.onnx): image uint8 [1,3,H,W] RGB,
// mask uint8 [1,1,H,W] where 0 marks pixels to erase (255 = keep);
// output uint8 [1,3,H,W]. Verified empirically — the polarity is inverted
// relative to the usual lama-cleaner convention.
// onnxruntime-web is browser-only; load it lazily so SSR never touches it.
import type { InferenceSession, Tensor } from 'onnxruntime-web'

type OrtModule = typeof import('onnxruntime-web/webgpu')

let ortPromise: Promise<OrtModule> | null = null
function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) ortPromise = import('onnxruntime-web/webgpu')
  return ortPromise
}

const MODEL_URL = '/models/migan_pipeline_v2.onnx'

export type InpaintProgress =
  | { stage: 'download'; loaded: number; total: number }
  | { stage: 'compile' }
  | { stage: 'run' }

type ProgressFn = (p: InpaintProgress) => void

let sessionPromise: Promise<InferenceSession> | null = null

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

async function fetchModel(onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const res = await fetch(MODEL_URL)
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onProgress?.({ stage: 'download', loaded, total })
  }
  const buffer = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.length
  }
  return buffer.buffer
}

async function createSession(onProgress?: ProgressFn): Promise<InferenceSession> {
  const ort = await loadOrt()
  ort.env.wasm.wasmPaths = '/ort/'
  const webgpu = await hasWebGPU()
  if (!webgpu) {
    ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency ?? 4, 8)
  }
  const buffer = await fetchModel(onProgress)
  onProgress?.({ stage: 'compile' })
  if (webgpu) {
    try {
      return await ort.InferenceSession.create(buffer, { executionProviders: ['webgpu'] })
    } catch {
      // fall through to wasm
    }
  }
  return ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] })
}

function getSession(onProgress?: ProgressFn): Promise<InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = createSession(onProgress).catch((err) => {
      sessionPromise = null
      throw err
    })
  }
  return sessionPromise
}

/** Warm the model (download + compile) ahead of the first erase. */
export function preloadModel(onProgress?: ProgressFn): Promise<unknown> {
  return getSession(onProgress)
}

type Rect = { x: number; y: number; w: number; h: number }

function maskBBox(mask: Uint8Array, w: number, h: number): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// The pipeline model resizes its input to 512px internally, so feeding the
// full image inpaints small marks at reduced resolution. Instead run on a
// ~512px context window centered on the mask and paste the result back.
const CROP_TARGET = 512
const CROP_PAD = 96

function computeCrop(bbox: Rect, w: number, h: number): Rect {
  const cw = Math.min(w, Math.max(CROP_TARGET, bbox.w + CROP_PAD * 2))
  const ch = Math.min(h, Math.max(CROP_TARGET, bbox.h + CROP_PAD * 2))
  const x = clamp(Math.round(bbox.x + bbox.w / 2 - cw / 2), 0, w - cw)
  const y = clamp(Math.round(bbox.y + bbox.h / 2 - ch / 2), 0, h - ch)
  return { x, y, w: cw, h: ch }
}

async function runModel(
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  onProgress?: ProgressFn
): Promise<Uint8Array> {
  const [ort, session] = await Promise.all([loadOrt(), getSession(onProgress)])
  onProgress?.({ stage: 'run' })

  const size = width * height
  const chw = new Uint8Array(3 * size)
  for (let i = 0; i < size; i++) {
    chw[i] = rgba[i * 4]
    chw[size + i] = rgba[i * 4 + 1]
    chw[2 * size + i] = rgba[i * 4 + 2]
  }
  const modelMask = new Uint8Array(size)
  for (let i = 0; i < size; i++) modelMask[i] = mask[i] === 0 ? 255 : 0

  const feeds: Record<string, Tensor> = {
    [session.inputNames[0]]: new ort.Tensor('uint8', chw, [1, 3, height, width]),
    [session.inputNames[1]]: new ort.Tensor('uint8', modelMask, [1, 1, height, width]),
  }
  const results = await session.run(feeds)
  return results[session.outputNames[0]].data as Uint8Array
}

/** Inpainted crop region: paste `data` at (x, y) on the source canvas. */
export type InpaintPatch = { x: number; y: number; data: ImageData }

/**
 * Erase the masked region of `image` and return only the affected crop as a
 * patch (full-frame copies of camera photos are ~50MB — enough to OOM-kill
 * mobile tabs). `mask` is one byte per pixel (width*height), 255 = erase,
 * 0 = keep (inverted to the model's convention internally). Returns null
 * when the mask is empty.
 */
export async function inpaint(
  image: ImageData,
  mask: Uint8Array,
  onProgress?: ProgressFn
): Promise<InpaintPatch | null> {
  const { width, height, data } = image
  if (mask.length !== width * height) throw new Error('Mask size does not match image')

  const bbox = maskBBox(mask, width, height)
  if (!bbox) return null

  const crop = computeCrop(bbox, width, height)

  // Extract crop image + mask.
  const cropSize = crop.w * crop.h
  const cropRgba = new Uint8ClampedArray(cropSize * 4)
  const cropMask = new Uint8Array(cropSize)
  for (let y = 0; y < crop.h; y++) {
    const srcRow = (crop.y + y) * width + crop.x
    const dstRow = y * crop.w
    cropRgba.set(data.subarray(srcRow * 4, (srcRow + crop.w) * 4), dstRow * 4)
    cropMask.set(mask.subarray(srcRow, srcRow + crop.w), dstRow)
  }

  const result = await runModel(cropRgba, cropMask, crop.w, crop.h, onProgress)

  // Paste only masked pixels onto the crop (the model returns the input elsewhere).
  for (let i = 0; i < cropSize; i++) {
    if (!cropMask[i]) continue
    cropRgba[i * 4] = result[i]
    cropRgba[i * 4 + 1] = result[cropSize + i]
    cropRgba[i * 4 + 2] = result[2 * cropSize + i]
  }
  return { x: crop.x, y: crop.y, data: new ImageData(cropRgba, crop.w, crop.h) }
}

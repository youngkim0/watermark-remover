// Background removal on-device with IS-Net (general use, Apache-2.0),
// quantized by scripts/quantize-isnet.py. One-shot: the session is created
// for a single run and released straight after, and MI-GAN is released
// before it — an iPhone tab cannot hold both arenas.
import { releaseModel } from '@/lib/inpaint'
import { MATTE_SIZE, outputToAlpha, toModelInput } from '@/lib/matte'
import { createOrtSession, type LoadProgress } from '@/lib/ort'

const MODEL_URL = '/models/isnet_general_q.onnx'

export type BgProgress = LoadProgress | { stage: 'run' }

/** Cut the subject out of `source`. Returns a canvas of the same size whose
 *  pixels are white and whose alpha is the cutout. */
export async function removeBackground(
  source: HTMLCanvasElement,
  onProgress?: (p: BgProgress) => void
): Promise<{ alpha: HTMLCanvasElement; ep: 'webgpu' | 'wasm'; ms: number }> {
  await releaseModel()
  // wasm only: the quantized graph is ConvInteger/DynamicQuantizeLinear
  // throughout, which ort-web's WebGPU EP has no kernels for — it would
  // bounce 1024² activations between GPU and CPU at every one, and its
  // output was never verified against wasm.
  const { session, ort, ep } = await createOrtSession(MODEL_URL, { onProgress, allowWebGPU: false })
  const scratch = document.createElement('canvas')
  scratch.width = scratch.height = MATTE_SIZE
  try {
    onProgress?.({ stage: 'run' })
    const t0 = performance.now()
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(source, 0, 0, MATTE_SIZE, MATTE_SIZE)
    const input = toModelInput(sctx.getImageData(0, 0, MATTE_SIZE, MATTE_SIZE).data)
    const tensor = new ort.Tensor('float32', input, [1, 3, MATTE_SIZE, MATTE_SIZE])
    // Only the final matte: fetching all six side outputs costs ~120MB of
    // garbage per run on WebKit.
    const outName = session.outputNames[0]
    const out = await session.run({ [session.inputNames[0]]: tensor }, [outName])
    const map = out[outName].data as Float32Array
    const rgba = outputToAlpha(map)
    out[outName].dispose?.()
    tensor.dispose?.()
    sctx.putImageData(new ImageData(rgba, MATTE_SIZE, MATTE_SIZE), 0, 0)
    const alpha = document.createElement('canvas')
    alpha.width = source.width
    alpha.height = source.height
    const actx = alpha.getContext('2d', { willReadFrequently: true })!
    actx.imageSmoothingQuality = 'high'
    actx.drawImage(scratch, 0, 0, source.width, source.height)
    return { alpha, ep, ms: Math.round(performance.now() - t0) }
  } finally {
    scratch.width = scratch.height = 0
    await session.release()
  }
}

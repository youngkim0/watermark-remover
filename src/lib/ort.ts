// Shared onnxruntime-web loading for every on-device model (MI-GAN, IS-Net).
// onnxruntime-web is browser-only; load it lazily so SSR never touches it.
import type { InferenceSession } from 'onnxruntime-web'

export type OrtModule = typeof import('onnxruntime-web/webgpu')

export type LoadProgress =
  | { stage: 'download'; loaded: number; total: number }
  | { stage: 'compile' }

let ortPromise: Promise<OrtModule> | null = null
export function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    // WebKit 26's wasm tier-up compiler chokes on ort's JSEP/JSPI builds:
    // CPU pegs and memory grows ~0.7GB per run() until iOS kills the tab
    // (onnxruntime#26827). The plain non-JSEP wasm backend is unaffected,
    // and WebKit never uses WebGPU here anyway (see isWebKitEngine).
    ortPromise = isWebKitEngine()
      ? (import('onnxruntime-web') as Promise<OrtModule>)
      : import('onnxruntime-web/webgpu')
  }
  return ortPromise
}

// ort-web's WebGPU EP is unsupported on iOS/WebKit (onnxruntime#22776):
// session creation can succeed and then session.run() crashes the WebKit
// content process — the page silently reloads, so no catch ever fires.
// All iOS browsers are WebKit, and only Chromium-likes ship "Chrome/" in
// the UA, so gate by engine rather than by navigator.gpu presence.
export function isWebKitEngine(): boolean {
  const ua = navigator.userAgent
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)
}

async function hasWebGPU(): Promise<boolean> {
  if (isWebKitEngine()) return false
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

async function fetchModel(url: string, onProgress?: (p: LoadProgress) => void): Promise<ArrayBuffer> {
  const res = await fetch(url)
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

/** Download `url` and create a session for it — WebGPU when allowed and
 *  available (never on WebKit), else multi-threaded wasm. */
export async function createOrtSession(
  url: string,
  opts: { onProgress?: (p: LoadProgress) => void; allowWebGPU: boolean }
): Promise<{ session: InferenceSession; ort: OrtModule; ep: 'webgpu' | 'wasm' }> {
  const ort = await loadOrt()
  // On WebKit, pin the exact non-JSEP binary — the loader would otherwise
  // feature-detect JSPI (WebKit 26 has it) and pick a build that triggers
  // the tier-up compiler bug above.
  ort.env.wasm.wasmPaths = isWebKitEngine()
    ? {
        wasm: '/ort/ort-wasm-simd-threaded.wasm',
        mjs: '/ort/ort-wasm-simd-threaded.mjs',
      }
    : '/ort/'
  const webgpu = opts.allowWebGPU && (await hasWebGPU())
  if (!webgpu) {
    ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency ?? 4, 8)
  }
  const buffer = await fetchModel(url, opts.onProgress)
  opts.onProgress?.({ stage: 'compile' })
  if (webgpu) {
    try {
      const session = await ort.InferenceSession.create(buffer, { executionProviders: ['webgpu'] })
      return { session, ort, ep: 'webgpu' }
    } catch {
      // fall through to wasm
    }
  }
  const session = await ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] })
  return { session, ort, ep: 'wasm' }
}

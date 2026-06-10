'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { inpaint, preloadModel, type InpaintProgress } from '@/lib/inpaint'

const MAX_SIDE = 4096
const MAX_UNDO = 30

type ModelStatus =
  | { state: 'loading'; pct: number | null }
  | { state: 'ready' }
  | { state: 'error' }

type Dims = { w: number; h: number }

function fitContain(img: Dims, box: Dims): Dims {
  const scale = Math.min(box.w / img.w, box.h / img.h, 1)
  return { w: Math.round(img.w * scale), h: Math.round(img.h * scale) }
}

export default function Editor({
  file,
  onReplace,
}: {
  file: File
  onReplace: () => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const imgCanvasRef = useRef<HTMLCanvasElement>(null)
  const origCanvasRef = useRef<HTMLCanvasElement>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)

  const drawState = useRef({ active: false, x: 0, y: 0 })
  const maskUndoStack = useRef<ImageData[]>([])
  const eraseHistory = useRef<ImageData[]>([])
  const busyRef = useRef(false)
  const autoRanRef = useRef(false)

  const [dims, setDims] = useState<Dims | null>(null)
  const [fit, setFit] = useState<Dims>({ w: 0, h: 0 })
  const [brush, setBrush] = useState(28) // display px
  const [maskActions, setMaskActions] = useState(0)
  const [eraseCount, setEraseCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [model, setModel] = useState<ModelStatus>({ state: 'loading', pct: null })
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  const onModelProgress = useCallback((p: InpaintProgress) => {
    if (p.stage === 'download') {
      setModel({ state: 'loading', pct: p.total ? p.loaded / p.total : null })
    } else if (p.stage === 'compile') {
      setModel({ state: 'loading', pct: 1 })
    }
  }, [])

  // Warm the model while the user is still brushing.
  useEffect(() => {
    let alive = true
    preloadModel(onModelProgress)
      .then(() => alive && setModel({ state: 'ready' }))
      .catch(() => alive && setModel({ state: 'error' }))
    return () => {
      alive = false
    }
  }, [onModelProgress])

  // Decode the file into the working + original canvases.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const bmp = await createImageBitmap(file)
        const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
        const w = Math.round(bmp.width * scale)
        const h = Math.round(bmp.height * scale)
        if (!alive) return
        for (const ref of [imgCanvasRef, origCanvasRef, maskCanvasRef]) {
          const c = ref.current!
          c.width = w
          c.height = h
        }
        for (const ref of [imgCanvasRef, origCanvasRef]) {
          ref.current!
            .getContext('2d', { willReadFrequently: true })!
            .drawImage(bmp, 0, 0, w, h)
        }
        bmp.close()
        maskUndoStack.current = []
        eraseHistory.current = []
        autoRanRef.current = false
        setMaskActions(0)
        setEraseCount(0)
        setError(null)
        setDims({ w, h })
      } catch {
        if (alive) setError('Could not read that image.')
      }
    })()
    return () => {
      alive = false
    }
  }, [file])

  // Fit the canvas wrapper to the stage.
  useEffect(() => {
    if (!dims || !stageRef.current) return
    const el = stageRef.current
    const update = () => {
      const r = el.getBoundingClientRect()
      setFit(fitContain(dims, { w: r.width - 48, h: r.height - 48 }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dims])

  const displayScale = dims && fit.w ? dims.w / fit.w : 1

  const maskCtx = () => maskCanvasRef.current!.getContext('2d', { willReadFrequently: true })!

  const snapshotMask = () => {
    if (!dims) return
    const snap = maskCtx().getImageData(0, 0, dims.w, dims.h)
    maskUndoStack.current.push(snap)
    if (maskUndoStack.current.length > MAX_UNDO) maskUndoStack.current.shift()
  }

  const toNatural = (e: React.PointerEvent) => {
    const rect = maskCanvasRef.current!.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * (dims?.w ?? 1),
      y: ((e.clientY - rect.top) / rect.height) * (dims?.h ?? 1),
    }
  }

  const paintSegment = (x0: number, y0: number, x1: number, y1: number) => {
    const ctx = maskCtx()
    ctx.strokeStyle = '#e8a33d'
    ctx.fillStyle = '#e8a33d'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = brush * displayScale
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy || !dims) return
    e.currentTarget.setPointerCapture(e.pointerId)
    snapshotMask()
    setMaskActions((n) => n + 1)
    const { x, y } = toNatural(e)
    drawState.current = { active: true, x, y }
    const ctx = maskCtx()
    ctx.fillStyle = '#e8a33d'
    ctx.beginPath()
    ctx.arc(x, y, (brush * displayScale) / 2, 0, Math.PI * 2)
    ctx.fill()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const rect = maskCanvasRef.current!.getBoundingClientRect()
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    if (!drawState.current.active || busy || !dims) return
    const { x, y } = toNatural(e)
    paintSegment(drawState.current.x, drawState.current.y, x, y)
    drawState.current = { active: true, x, y }
  }

  const endStroke = () => {
    drawState.current.active = false
  }

  /** Paint a mask over the bottom-right corner where the ✦ watermark sits. */
  const paintCornerMask = (d: Dims) => {
    const s = Math.round(Math.min(d.w, d.h) * 0.17)
    const margin = Math.round(Math.min(d.w, d.h) * 0.015)
    const ctx = maskCtx()
    ctx.fillStyle = '#e8a33d'
    ctx.beginPath()
    ctx.roundRect(d.w - s - margin, d.h - s - margin, s, s, s * 0.18)
    ctx.fill()
  }

  /** One-tap corner mask (manual button). */
  const cornerPreset = () => {
    if (!dims || busy) return
    snapshotMask()
    setMaskActions((n) => n + 1)
    paintCornerMask(dims)
  }

  const undo = () => {
    if (busy || !dims) return
    if (maskUndoStack.current.length > 0) {
      const snap = maskUndoStack.current.pop()!
      maskCtx().putImageData(snap, 0, 0)
      setMaskActions((n) => Math.max(0, n - 1))
      return
    }
    const prev = eraseHistory.current.pop()
    if (prev) {
      imgCanvasRef.current!.getContext('2d')!.putImageData(prev, 0, 0)
      setEraseCount((n) => Math.max(0, n - 1))
    }
  }

  const clearMask = useCallback(() => {
    if (busy || !dims) return
    maskCtx().clearRect(0, 0, dims.w, dims.h)
    maskUndoStack.current = []
    setMaskActions(0)
  }, [busy, dims])

  // Core erase: reconstructs whatever is painted on the mask canvas.
  const runErase = useCallback(async () => {
    if (busyRef.current || !dims) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const imgCtx = imgCanvasRef.current!.getContext('2d', { willReadFrequently: true })!
      const image = imgCtx.getImageData(0, 0, dims.w, dims.h)
      const maskData = maskCtx().getImageData(0, 0, dims.w, dims.h)
      const mask = new Uint8Array(dims.w * dims.h)
      let painted = 0
      for (let i = 0; i < mask.length; i++) {
        if (maskData.data[i * 4 + 3] > 16) {
          mask[i] = 255
          painted++
        }
      }
      if (painted === 0) return
      const result = await inpaint(image, mask, onModelProgress)
      setModel({ state: 'ready' })
      eraseHistory.current.push(image)
      if (eraseHistory.current.length > MAX_UNDO) eraseHistory.current.shift()
      imgCtx.putImageData(result, 0, 0)
      maskCtx().clearRect(0, 0, dims.w, dims.h)
      maskUndoStack.current = []
      setMaskActions(0)
      setEraseCount((n) => n + 1)
    } catch (err) {
      console.error(err)
      setError('Inpainting failed — try a smaller image or reload.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [dims, onModelProgress])

  const erase = useCallback(() => {
    if (maskActions === 0) return
    void runErase()
  }, [maskActions, runErase])

  // Automatically remove the corner watermark once the image is decoded and
  // the model is ready — the user lands straight on the cleaned result.
  useEffect(() => {
    if (autoRanRef.current || !dims || model.state !== 'ready' || busyRef.current) return
    autoRanRef.current = true
    paintCornerMask(dims)
    void runErase()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims, model.state, runErase])

  const download = () => {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('')
    imgCanvasRef.current!.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Unmark_${token}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  // Keyboard: [ ] brush size, cmd/ctrl+z undo, hold c to compare.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === '[') setBrush((b) => Math.max(8, b - 4))
      if (e.key === ']') setBrush((b) => Math.min(96, b + 4))
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
      if (e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey) setComparing(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'c') setComparing(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, dims])

  const status = busy
    ? 'removing watermark…'
    : eraseCount > 0
      ? 'watermark removed — brush to refine, or save your image'
      : model.state === 'error'
        ? 'model unavailable'
        : model.state === 'ready'
          ? 'model ready'
          : model.pct === null
            ? 'loading model…'
            : model.pct >= 1
              ? 'compiling model…'
              : `loading model ${Math.round(model.pct * 100)}%`

  return (
    <div className="flex-1 min-h-0 flex flex-col fade-up">
      {/* stage */}
      <div ref={stageRef} className="relative flex-1 min-h-0 flex items-center justify-center">
        <div
          className="relative"
          style={{ width: fit.w || undefined, height: fit.h || undefined, cursor: 'none' }}
        >
          <canvas
            ref={imgCanvasRef}
            className="absolute inset-0 w-full h-full"
            style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.55)' }}
          />
          <canvas
            ref={origCanvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none transition-opacity duration-100"
            style={{ opacity: comparing ? 1 : 0 }}
          />
          <canvas
            ref={maskCanvasRef}
            className="absolute inset-0 w-full h-full touch-none"
            style={{ opacity: comparing ? 0 : 0.5, transition: 'opacity 100ms' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={() => {
              endStroke()
              setCursor(null)
            }}
          />
          {/* brush cursor */}
          {cursor && !busy && (
            <div
              aria-hidden
              className="absolute pointer-events-none rounded-full border"
              style={{
                left: cursor.x - brush / 2,
                top: cursor.y - brush / 2,
                width: brush,
                height: brush,
                borderColor: 'var(--amber)',
                background: 'rgba(232,163,61,0.12)',
              }}
            />
          )}
          {/* processing veil */}
          {busy && (
            <div className="absolute inset-0 flex items-end justify-center pb-4 bg-black/30">
              <span className="label text-amber pulse-dim">removing watermark…</span>
            </div>
          )}
          {comparing && (
            <div className="absolute top-3 left-3 label text-ink-dim bg-black/50 px-2 py-1 pointer-events-none">
              original
            </div>
          )}
        </div>
        {/* indeterminate bar while busy */}
        {busy && (
          <div className="absolute top-0 left-0 right-0 h-px overflow-hidden">
            <div
              className="h-full w-1/4 progress-indeterminate"
              style={{ background: 'var(--amber)' }}
            />
          </div>
        )}
      </div>

      {/* status / error line */}
      <div className="px-6 pb-2 flex justify-center">
        <span
          className="label"
          style={{
            color: error
              ? '#d96c47'
              : eraseCount > 0 && !busy
                ? 'var(--amber)'
                : 'var(--ink-faint)',
          }}
        >
          {error ?? status}
        </span>
      </div>

      {/* toolbar */}
      <div className="px-6 pb-6 flex flex-wrap items-center justify-center gap-2">
        <div className="ctrl flex items-center gap-3 px-4 h-10">
          <span className="label">brush</span>
          <input
            type="range"
            min={8}
            max={96}
            value={brush}
            onChange={(e) => setBrush(Number(e.target.value))}
            className="w-24"
            aria-label="Brush size"
          />
        </div>
        <button type="button" className="ctrl label px-4 h-10 cursor-pointer" onClick={cornerPreset} disabled={busy}>
          ✦ corner
        </button>
        <button
          type="button"
          className="ctrl label px-4 h-10 cursor-pointer"
          onClick={undo}
          disabled={busy || (maskActions === 0 && eraseCount === 0)}
        >
          undo
        </button>
        <button
          type="button"
          className="ctrl label px-4 h-10 cursor-pointer"
          onClick={clearMask}
          disabled={busy || maskActions === 0}
        >
          clear
        </button>
        <button
          type="button"
          onClick={erase}
          disabled={busy || maskActions === 0 || model.state === 'error'}
          className="label px-7 h-10 cursor-pointer transition-colors duration-150 disabled:opacity-35 disabled:cursor-not-allowed"
          style={{
            background: 'var(--amber)',
            color: '#181612',
            fontWeight: 500,
          }}
        >
          {busy ? 'working' : 'erase'}
        </button>
        <span aria-hidden className="w-px h-6 mx-2" style={{ background: 'var(--line)' }} />
        <button
          type="button"
          className="ctrl label px-4 h-10 cursor-pointer select-none"
          data-active={comparing}
          disabled={eraseCount === 0}
          onPointerDown={() => setComparing(true)}
          onPointerUp={() => setComparing(false)}
          onPointerLeave={() => setComparing(false)}
        >
          hold to compare
        </button>
        <button
          type="button"
          className="ctrl label px-4 h-10 cursor-pointer"
          onClick={download}
          disabled={busy || eraseCount === 0}
        >
          save png
        </button>
        <button type="button" className="ctrl label px-4 h-10 cursor-pointer" onClick={onReplace} disabled={busy}>
          new image
        </button>
      </div>
    </div>
  )
}

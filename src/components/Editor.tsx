'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  computeCrop,
  inpaint,
  preloadModel,
  type InpaintPatch,
  type InpaintProgress,
  type Rect,
} from '@/lib/inpaint'
import { track } from '@/lib/analytics'

const MAX_SIDE = 4096
// iOS Safari rejects canvases over ~16.7M pixels (4096²); stay clear of it.
const MAX_AREA = 14_000_000
const MAX_UNDO = 30
// Total bytes of erase-undo pixel data to retain. Mobile tabs are killed by
// the OS at a few hundred MB, so cap well below that.
const MAX_UNDO_BYTES = 96 * 1024 * 1024
const MASK_COLOR = '#e8a33d'

type ModelStatus =
  | { state: 'loading'; pct: number | null }
  | { state: 'ready' }
  | { state: 'error' }

type Dims = { w: number; h: number }

// Mask undo is stroke replay, not pixel snapshots: a full-res ImageData per
// stroke is ~50MB for a camera photo, which OOM-kills mobile tabs in a few
// strokes. Stroke vectors are a few KB and redraw in microseconds.
type MaskStroke =
  | { kind: 'brush'; width: number; points: { x: number; y: number }[] }
  | { kind: 'corner' }

/** Bottom-right square where the ✦ watermark sits. */
function cornerRect(d: Dims): Rect {
  const s = Math.round(Math.min(d.w, d.h) * 0.17)
  const margin = Math.round(Math.min(d.w, d.h) * 0.015)
  return { x: d.w - s - margin, y: d.h - s - margin, w: s, h: s }
}

/** Bounding box of everything painted, from stroke geometry — avoids
 *  reading full-resolution pixel data to find the mask. */
function strokesBBox(strokes: MaskStroke[], d: Dims): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of strokes) {
    if (s.kind === 'corner') {
      const r = cornerRect(d)
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y)
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h)
    } else {
      const r = s.width / 2 + 1
      for (const pt of s.points) {
        x0 = Math.min(x0, pt.x - r); y0 = Math.min(y0, pt.y - r)
        x1 = Math.max(x1, pt.x + r); y1 = Math.max(y1, pt.y + r)
      }
    }
  }
  if (x1 < x0) return null
  const cx = (v: number) => Math.min(Math.max(Math.round(v), 0), d.w)
  const cy = (v: number) => Math.min(Math.max(Math.round(v), 0), d.h)
  const bx = cx(x0), by = cy(y0)
  const bw = cx(x1) - bx, bh = cy(y1) - by
  return bw > 0 && bh > 0 ? { x: bx, y: by, w: bw, h: bh } : null
}

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
  const maskStrokes = useRef<MaskStroke[]>([])
  const eraseHistory = useRef<InpaintPatch[]>([])
  const busyRef = useRef(false)

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
    const t0 = performance.now()
    preloadModel(onModelProgress)
      .then(() => {
        if (!alive) return
        setModel({ state: 'ready' })
        track('model-loaded', { ms: Math.round(performance.now() - t0) })
      })
      .catch(() => {
        if (!alive) return
        setModel({ state: 'error' })
        track('model-error')
      })
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
        const scale = Math.min(
          1,
          MAX_SIDE / Math.max(bmp.width, bmp.height),
          Math.sqrt(MAX_AREA / (bmp.width * bmp.height))
        )
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
        maskStrokes.current = []
        eraseHistory.current = []
        setMaskActions(0)
        setEraseCount(0)
        setError(null)
        setDims({ w, h })
      } catch {
        if (alive) {
          setError('Could not read that image.')
          track('image-error')
        }
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

  const toNatural = (e: React.PointerEvent) => {
    const rect = maskCanvasRef.current!.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * (dims?.w ?? 1),
      y: ((e.clientY - rect.top) / rect.height) * (dims?.h ?? 1),
    }
  }

  const paintDot = (x: number, y: number, width: number) => {
    const ctx = maskCtx()
    ctx.fillStyle = MASK_COLOR
    ctx.beginPath()
    ctx.arc(x, y, width / 2, 0, Math.PI * 2)
    ctx.fill()
  }

  const paintSegment = (x0: number, y0: number, x1: number, y1: number, width: number) => {
    const ctx = maskCtx()
    ctx.strokeStyle = MASK_COLOR
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy || !dims) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setMaskActions((n) => n + 1)
    const { x, y } = toNatural(e)
    const width = brush * displayScale
    maskStrokes.current.push({ kind: 'brush', width, points: [{ x, y }] })
    drawState.current = { active: true, x, y }
    paintDot(x, y, width)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const rect = maskCanvasRef.current!.getBoundingClientRect()
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    if (!drawState.current.active || busy || !dims) return
    const { x, y } = toNatural(e)
    const stroke = maskStrokes.current[maskStrokes.current.length - 1]
    if (stroke?.kind === 'brush') {
      stroke.points.push({ x, y })
      paintSegment(drawState.current.x, drawState.current.y, x, y, stroke.width)
    }
    drawState.current = { active: true, x, y }
  }

  const endStroke = () => {
    drawState.current.active = false
  }

  /** Paint a mask over the bottom-right corner where the ✦ watermark sits. */
  const paintCornerMask = (d: Dims) => {
    const r = cornerRect(d)
    const ctx = maskCtx()
    ctx.fillStyle = MASK_COLOR
    ctx.beginPath()
    ctx.roundRect(r.x, r.y, r.w, r.h, r.w * 0.18)
    ctx.fill()
  }

  /** One-tap corner mask (manual button). */
  const cornerPreset = () => {
    if (!dims || busy) return
    maskStrokes.current.push({ kind: 'corner' })
    setMaskActions((n) => n + 1)
    paintCornerMask(dims)
    track('corner-preset')
  }

  /** Rebuild the mask canvas from the stroke list (after an undo). */
  const replayMask = (d: Dims) => {
    maskCtx().clearRect(0, 0, d.w, d.h)
    for (const s of maskStrokes.current) {
      if (s.kind === 'corner') {
        paintCornerMask(d)
        continue
      }
      paintDot(s.points[0].x, s.points[0].y, s.width)
      for (let i = 1; i < s.points.length; i++) {
        paintSegment(s.points[i - 1].x, s.points[i - 1].y, s.points[i].x, s.points[i].y, s.width)
      }
    }
  }

  const undo = () => {
    if (busy || !dims) return
    if (maskStrokes.current.length > 0) {
      maskStrokes.current.pop()
      replayMask(dims)
      setMaskActions((n) => Math.max(0, n - 1))
      track('undo')
      return
    }
    const prev = eraseHistory.current.pop()
    if (prev) {
      imgCanvasRef.current!.getContext('2d')!.putImageData(prev.data, prev.x, prev.y)
      setEraseCount((n) => Math.max(0, n - 1))
      track('undo')
    }
  }

  const clearMask = useCallback(() => {
    if (busy || !dims) return
    maskCtx().clearRect(0, 0, dims.w, dims.h)
    maskStrokes.current = []
    setMaskActions(0)
    track('clear-mask')
  }, [busy, dims])

  // Core erase: reconstructs whatever is painted on the mask canvas.
  const runErase = useCallback(async () => {
    if (busyRef.current || !dims) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      // Work on the crop window around the mask, never the full frame:
      // two full-res ImageData reads per erase (~100MB on a 12MP photo)
      // are enough churn to get mobile tabs killed.
      const bbox = strokesBBox(maskStrokes.current, dims)
      if (!bbox) return
      const crop = computeCrop(bbox, dims.w, dims.h)
      const imgCtx = imgCanvasRef.current!.getContext('2d', { willReadFrequently: true })!
      const image = imgCtx.getImageData(crop.x, crop.y, crop.w, crop.h)
      const maskData = maskCtx().getImageData(crop.x, crop.y, crop.w, crop.h)
      const mask = new Uint8Array(crop.w * crop.h)
      let painted = 0
      for (let i = 0; i < mask.length; i++) {
        if (maskData.data[i * 4 + 3] > 16) {
          mask[i] = 255
          painted++
        }
      }
      if (painted === 0) return
      const t0 = performance.now()
      const result = await inpaint(image, mask, onModelProgress)
      track('erase', { count: eraseCount + 1, ms: Math.round(performance.now() - t0) })
      setModel({ state: 'ready' })
      if (result) {
        const ax = crop.x + result.x
        const ay = crop.y + result.y
        const prior = imgCtx.getImageData(ax, ay, result.data.width, result.data.height)
        eraseHistory.current.push({ x: ax, y: ay, data: prior })
        let bytes = eraseHistory.current.reduce((n, p) => n + p.data.data.byteLength, 0)
        while (
          eraseHistory.current.length > MAX_UNDO ||
          (bytes > MAX_UNDO_BYTES && eraseHistory.current.length > 1)
        ) {
          bytes -= eraseHistory.current.shift()!.data.data.byteLength
        }
        imgCtx.putImageData(result.data, ax, ay)
      }
      maskCtx().clearRect(0, 0, dims.w, dims.h)
      maskStrokes.current = []
      setMaskActions(0)
      setEraseCount((n) => n + 1)
    } catch (err) {
      console.error(err)
      setError('Inpainting failed — try a smaller image or reload.')
      track('erase-error')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [dims, eraseCount, onModelProgress])

  const erase = useCallback(() => {
    if (maskActions === 0) return
    void runErase()
  }, [maskActions, runErase])

  const download = () => {
    track('download', { erases: eraseCount })
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
      if (e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey) {
        if (!e.repeat) track('compare')
        setComparing(true)
      }
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
    ? 'erasing…'
    : eraseCount > 0
      ? 'erased — brush over anything else, or save your image'
      : model.state === 'error'
        ? 'model unavailable'
        : model.state === 'ready'
          ? 'tap ✦ corner for the watermark, or brush over anything — then erase'
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
              <span className="label text-amber pulse-dim">erasing…</span>
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
          onPointerDown={() => {
            track('compare')
            setComparing(true)
          }}
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
        <button
          type="button"
          className="ctrl label px-4 h-10 cursor-pointer"
          onClick={() => {
            track('replace-image')
            onReplace()
          }}
          disabled={busy}
        >
          new image
        </button>
      </div>
    </div>
  )
}

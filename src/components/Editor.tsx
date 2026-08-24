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
import { detectMarks } from '@/lib/detect'
import CropOverlay from './CropOverlay'
import TextControls from './TextControls'
import GlitterControls from './GlitterControls'
import TextEditOverlay from './TextEditOverlay'
import ZoomControls from './ZoomControls'
import { useViewTransform } from '@/lib/useViewTransform'
import { useTextTool } from '@/lib/useTextTool'
import { drawTextItems, loadFontsFor, measureTextItem, type TextItem } from '@/lib/text'
import { useGlitterTool } from '@/lib/useGlitterTool'
import { drawGlitterItems, measureGlitterItem, type GlitterItem } from '@/lib/glitter'

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
  | { kind: 'detect'; rects: Rect[] }

// One entry per erase action; an action may inpaint several clusters (each
// contributing a patch) and swallow text or sparkles brushed over. Undo
// restores the whole entry: patches in reverse order, then the removed
// overlay items.
type EraseUndo = { patches: InpaintPatch[]; texts: TextItem[]; glitters: GlitterItem[] }

// Single-level crop undo: the full pre-crop image + original planes, plus the
// erase-undo stack that was valid against them. Kept only when it fits under
// MAX_UNDO_BYTES (two full planes + copied patches); otherwise a crop is final.
type CropUndo = {
  dims: Dims
  image: ImageData
  orig: ImageData
  eraseHistory: EraseUndo[]
  eraseCountBefore: number
  textItems: TextItem[]
  glitterItems: GlitterItem[]
}

/** Per-stroke mask bounding boxes, from stroke geometry — avoids reading
 *  full-resolution pixel data to find the mask. Detect strokes contribute
 *  one box per detected rect so distant marks can be clustered apart. */
function strokeRects(strokes: MaskStroke[], d: Dims): Rect[] {
  const out: Rect[] = []
  const push = (x0: number, y0: number, x1: number, y1: number) => {
    const cx = (v: number) => Math.min(Math.max(Math.round(v), 0), d.w)
    const cy = (v: number) => Math.min(Math.max(Math.round(v), 0), d.h)
    const bx = cx(x0), by = cy(y0)
    const bw = cx(x1) - bx, bh = cy(y1) - by
    if (bw > 0 && bh > 0) out.push({ x: bx, y: by, w: bw, h: bh })
  }
  for (const s of strokes) {
    if (s.kind === 'detect') {
      for (const r of s.rects) push(r.x, r.y, r.x + r.w, r.y + r.h)
    } else {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      const r = s.width / 2 + 1
      for (const pt of s.points) {
        x0 = Math.min(x0, pt.x - r); y0 = Math.min(y0, pt.y - r)
        x1 = Math.max(x1, pt.x + r); y1 = Math.max(y1, pt.y + r)
      }
      if (x1 >= x0) push(x0, y0, x1, y1)
    }
  }
  return out
}

/** Drop the mask strokes that served to delete an overlay item, so the erase
 *  doesn't also inpaint the photo underneath it (that only smears untouched
 *  pixels — the item was never part of the image). A stroke goes when most of
 *  it lies over the removed items' footprints. */
function dropOverlayStrokes(
  strokes: MaskStroke[],
  boxes: { x: number; y: number; w: number; h: number }[],
  d: Dims
): MaskStroke[] {
  const margin = 12
  return strokes.filter((s) => {
    if (s.kind === 'detect') return true
    const [r] = strokeRects([s], d)
    if (!r) return false
    let cover = 0
    for (const b of boxes) {
      const ix = Math.min(r.x + r.w, b.x + b.w + margin) - Math.max(r.x, b.x - margin)
      const iy = Math.min(r.y + r.h, b.y + b.h + margin) - Math.max(r.y, b.y - margin)
      if (ix > 0 && iy > 0) cover += ix * iy
    }
    return cover < 0.7 * r.w * r.h
  })
}

// Marks farther apart than this run as separate inpaints. The model works at
// 512px internally, so one crop window spanning distant marks (e.g. detect
// hits in opposite corners) would be heavily downscaled and paste back blurry.
const CLUSTER_GAP = 192

/** Merge boxes transitively while they come within `gap` of each other. */
function clusterRects(rects: Rect[], gap: number): Rect[] {
  const out = rects.map((r) => ({ ...r }))
  for (let merged = true; merged; ) {
    merged = false
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j]
        if (
          a.x - gap < b.x + b.w && b.x - gap < a.x + a.w &&
          a.y - gap < b.y + b.h && b.y - gap < a.y + a.h
        ) {
          const x = Math.min(a.x, b.x)
          const y = Math.min(a.y, b.y)
          out[i] = {
            x, y,
            w: Math.max(a.x + a.w, b.x + b.w) - x,
            h: Math.max(a.y + a.h, b.y + b.h) - y,
          }
          out.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return out
}

const entryBytes = (g: EraseUndo) => g.patches.reduce((n, p) => n + p.data.data.byteLength, 0)

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
  const textCanvasRef = useRef<HTMLCanvasElement>(null)
  const glitterCanvasRef = useRef<HTMLCanvasElement>(null)
  const imgBoxRef = useRef<HTMLDivElement>(null)

  const drawState = useRef({ active: false, x: 0, y: 0 })
  const maskStrokes = useRef<MaskStroke[]>([])
  const eraseHistory = useRef<EraseUndo[]>([])
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
  const [cursor, setCursor] = useState<{ x: number; y: number; z: number } | null>(null)
  const [cropping, setCropping] = useState(false)
  const [detectResult, setDetectResult] = useState<'found' | 'none' | null>(null)
  const [cropUndoAvailable, setCropUndoAvailable] = useState(false)
  const [tool, setTool] = useState<'erase' | 'text' | 'glitter'>('erase')
  const cropRectRef = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 })
  const cropUndo = useRef<CropUndo | null>(null)
  const [originalDims, setOriginalDims] = useState<Dims | null>(null)

  const textTool = useTextTool({ canvasRef: textCanvasRef, dims })
  const { reset: resetText, removeCovered: removeCoveredText, addBack: addBackText } = textTool
  const glitterTool = useGlitterTool({ canvasRef: glitterCanvasRef, dims })
  const {
    reset: resetGlitter,
    removeCovered: removeCoveredGlitter,
    addBack: addBackGlitter,
  } = glitterTool

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
        for (const ref of [imgCanvasRef, origCanvasRef, maskCanvasRef, textCanvasRef, glitterCanvasRef]) {
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
        cropUndo.current = null
        resetText()
        resetGlitter()
        setTool('erase')
        setOriginalDims({ w, h })
        setCropUndoAvailable(false)
        setCropping(false)
        setDetectResult(null)
        setMaskActions(0)
        setEraseCount(0)
        setError(null)
        setDims({ w, h })
        // One count per image actually opened in the editor ("processed").
        track('image-open', { w, h })
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
  }, [file, resetText, resetGlitter])

  // Fit the canvas wrapper to the stage.
  useEffect(() => {
    if (!dims || !stageRef.current) return
    const el = stageRef.current
    const update = () => {
      const r = el.getBoundingClientRect()
      // Tighter breathing room on phones so the image can claim the width.
      const pad = window.innerWidth < 640 ? 16 : 48
      setFit(fitContain(dims, { w: r.width - pad, h: r.height - pad }))
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
    if (view.onPointerDown(e)) return // pinch / space-pan consumed the event
    if (busy || !dims || cropping) return
    if (tool === 'text') {
      // A tap outside the inline editor commits the in-progress edit (the
      // editor stops propagation, so reaching here means "outside").
      if (textTool.editing) {
        ;(document.activeElement as HTMLElement | null)?.blur?.()
      }
      textTool.onPointerDown(e)
      return
    }
    if (tool === 'glitter') {
      glitterTool.onPointerDown(e)
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDetectResult(null)
    setMaskActions((n) => n + 1)
    const rect = maskCanvasRef.current!.getBoundingClientRect()
    const { x, y } = toNatural(e)
    // Screen→natural ratio from the live (already-scaled) rect, so the brush
    // paints a finer natural footprint when zoomed in.
    const width = brush * (rect.width ? dims.w / rect.width : displayScale)
    maskStrokes.current.push({ kind: 'brush', width, points: [{ x, y }] })
    drawState.current = { active: true, x, y }
    paintDot(x, y, width)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (view.onPointerMove(e)) {
      setCursor(null) // hide brush preview during a gesture
      return
    }
    if (tool === 'text') {
      textTool.onPointerMove(e)
      return
    }
    if (tool === 'glitter') {
      glitterTool.onPointerMove(e)
      return
    }
    const rect = maskCanvasRef.current!.getBoundingClientRect()
    const z = fit.w ? rect.width / fit.w : 1
    setCursor({ x: (e.clientX - rect.left) / z, y: (e.clientY - rect.top) / z, z })
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
    textTool.onPointerUp()
    glitterTool.onPointerUp()
    drawState.current.active = false
  }

  // Drop the in-progress brush stroke (used when a pinch starts mid-stroke).
  const cancelStroke = () => {
    if (!drawState.current.active) return
    drawState.current.active = false
    const last = maskStrokes.current[maskStrokes.current.length - 1]
    if (last?.kind === 'brush') {
      maskStrokes.current.pop()
      setMaskActions((n) => Math.max(0, n - 1))
      if (dims) replayMask(dims)
    }
  }

  const view = useViewTransform({
    containerRef: imgBoxRef,
    fit,
    enabled: !cropping,
    onPinchStart: cancelStroke,
    // Erase hides the OS cursor behind the brush-circle preview; every other
    // tool needs a visible pointer over the image.
    baseCursor: tool === 'erase' && !cropping ? 'none' : 'default',
  })

  // Reset zoom/pan to fit whenever a new image is loaded.
  useEffect(() => {
    view.fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  /** Paint the mask over detected watermark regions. */
  const paintDetect = (rects: Rect[]) => {
    const ctx = maskCtx()
    ctx.fillStyle = MASK_COLOR
    for (const r of rects) {
      ctx.beginPath()
      ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.18)
      ctx.fill()
    }
  }

  /** Find known AI watermarks and pre-paint the mask over them.
   *  Returns the number of marks found. */
  const runDetect = async (auto: boolean): Promise<number> => {
    if (!dims || busyRef.current) return 0
    const t0 = performance.now()
    const imgCtx = imgCanvasRef.current!.getContext('2d', { willReadFrequently: true })!
    const marks = await detectMarks(imgCtx.getImageData(0, 0, dims.w, dims.h))
    track('detect', { found: marks.length, ms: Math.round(performance.now() - t0), auto })
    if (marks.length === 0) return 0
    if (!imgCanvasRef.current) return 0
    maskStrokes.current.push({ kind: 'detect', rects: marks.map((m) => m.rect) })
    setMaskActions((n) => n + 1)
    paintDetect(marks.map((m) => m.rect))
    return marks.length
  }

  const detectPressed = async () => {
    if (busy || !dims || cropping) return
    const n = await runDetect(false)
    setDetectResult(n > 0 ? 'found' : 'none')
  }

  // Auto-detect once per opened image; silent when nothing is found. Skips
  // if the user already started working (brush/crop/erase) before results.
  useEffect(() => {
    if (!dims) return
    let alive = true
    ;(async () => {
      if (maskStrokes.current.length > 0 || eraseCount > 0 || cropping) return
      const n = await runDetect(true)
      if (alive && n > 0) setDetectResult('found')
    })()
    return () => {
      alive = false
    }
    // Re-run only when a new image (or crop) finishes sizing the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims])

  /** Rebuild the mask canvas from the stroke list (after an undo). */
  const replayMask = (d: Dims) => {
    maskCtx().clearRect(0, 0, d.w, d.h)
    for (const s of maskStrokes.current) {
      if (s.kind === 'detect') {
        paintDetect(s.rects)
        continue
      }
      paintDot(s.points[0].x, s.points[0].y, s.width)
      for (let i = 1; i < s.points.length; i++) {
        paintSegment(s.points[i - 1].x, s.points[i - 1].y, s.points[i].x, s.points[i].y, s.width)
      }
    }
  }

  const undo = () => {
    if (busy || !dims || cropping) return
    if (maskStrokes.current.length > 0) {
      maskStrokes.current.pop()
      replayMask(dims)
      setMaskActions((n) => Math.max(0, n - 1))
      setDetectResult(null)
      track('undo')
      return
    }
    const prev = eraseHistory.current.pop()
    if (prev) {
      const ctx = imgCanvasRef.current!.getContext('2d')!
      for (let i = prev.patches.length - 1; i >= 0; i--) {
        ctx.putImageData(prev.patches[i].data, prev.patches[i].x, prev.patches[i].y)
      }
      textTool.addBack(prev.texts)
      glitterTool.addBack(prev.glitters)
      setEraseCount((n) => Math.max(0, n - 1))
      track('undo')
      return
    }
    const c = cropUndo.current
    if (c) {
      for (const [canvas, snap] of [
        [imgCanvasRef.current!, c.image],
        [origCanvasRef.current!, c.orig],
      ] as const) {
        canvas.width = c.dims.w
        canvas.height = c.dims.h
        canvas.getContext('2d', { willReadFrequently: true })!.putImageData(snap, 0, 0)
      }
      maskCanvasRef.current!.width = c.dims.w
      maskCanvasRef.current!.height = c.dims.h
      textCanvasRef.current!.width = c.dims.w
      textCanvasRef.current!.height = c.dims.h
      glitterCanvasRef.current!.width = c.dims.w
      glitterCanvasRef.current!.height = c.dims.h
      maskStrokes.current = []
      eraseHistory.current = c.eraseHistory
      textTool.restore(c.textItems)
      glitterTool.restore(c.glitterItems)
      setMaskActions(0)
      setEraseCount(c.eraseCountBefore)
      setDims({ w: c.dims.w, h: c.dims.h })
      cropUndo.current = null
      setCropUndoAvailable(false)
      track('undo')
    }
  }

  const clearMask = useCallback(() => {
    if (busy || !dims) return
    maskCtx().clearRect(0, 0, dims.w, dims.h)
    maskStrokes.current = []
    setMaskActions(0)
    setDetectResult(null)
    track('clear-mask')
  }, [busy, dims])

  // Core erase: reconstructs whatever is painted on the mask canvas.
  const runErase = useCallback(async () => {
    if (busyRef.current || !dims) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    // Hoisted so the catch block can undo whatever succeeded before a
    // mid-erase failure (e.g. mobile OOM inside inpaint()): these are the
    // same pieces a successful run would have bundled into an undo entry.
    const patches: InpaintPatch[] = []
    let removedTexts: TextItem[] = []
    let removedGlitters: GlitterItem[] = []
    // Once the undo entry is pushed, the work is the history's to reverse —
    // the catch below must not also roll it back.
    let committed = false
    try {
      const boxes0 = strokeRects(maskStrokes.current, dims)
      if (boxes0.length === 0) return
      const t0 = performance.now()

      // Overlay items go first: brushing over your own text or sparkle means
      // "erase that", and since neither was ever part of the image, the photo
      // beneath must not be inpainted — that only smears untouched pixels.
      // Strokes that served to delete an overlay item are dropped entirely.
      removedTexts = removeCoveredText(boxes0)
      removedGlitters = removeCoveredGlitter(boxes0)
      if (removedTexts.length > 0 || removedGlitters.length > 0) {
        const overlayBoxes = [
          ...removedTexts.map((t) => measureTextItem(t)),
          ...removedGlitters.map((g) => measureGlitterItem(g)),
        ]
        const before = maskStrokes.current.length
        maskStrokes.current = dropOverlayStrokes(maskStrokes.current, overlayBoxes, dims)
        if (maskStrokes.current.length !== before) replayMask(dims)
      }

      // Work on crop windows around the remaining mask, never the full frame:
      // two full-res ImageData reads per erase (~100MB on a 12MP photo)
      // are enough churn to get mobile tabs killed. Distant marks run as
      // separate clusters so each keeps a tight, near-native-res window.
      const boxes = strokeRects(maskStrokes.current, dims)
      const clusters = clusterRects(boxes, CLUSTER_GAP)
      const imgCtx = imgCanvasRef.current!.getContext('2d', { willReadFrequently: true })!
      let painted = 0
      for (const bbox of clusters) {
        const crop = computeCrop(bbox, dims.w, dims.h)
        const image = imgCtx.getImageData(crop.x, crop.y, crop.w, crop.h)
        const maskData = maskCtx().getImageData(crop.x, crop.y, crop.w, crop.h)
        const mask = new Uint8Array(crop.w * crop.h)
        let clusterPainted = 0
        for (let i = 0; i < mask.length; i++) {
          if (maskData.data[i * 4 + 3] > 16) {
            mask[i] = 255
            clusterPainted++
          }
        }
        painted += clusterPainted
        if (clusterPainted === 0) continue
        const result = await inpaint(image, mask, onModelProgress)
        if (result) {
          const ax = crop.x + result.x
          const ay = crop.y + result.y
          const prior = imgCtx.getImageData(ax, ay, result.data.width, result.data.height)
          patches.push({ x: ax, y: ay, data: prior })
          imgCtx.putImageData(result.data, ax, ay)
        }
      }
      if (painted === 0 && removedTexts.length === 0 && removedGlitters.length === 0) return
      track('erase', {
        count: eraseCount + 1,
        clusters: clusters.length,
        texts: removedTexts.length,
        glitters: removedGlitters.length,
        ms: Math.round(performance.now() - t0),
      })
      setModel({ state: 'ready' })
      if (patches.length > 0 || removedTexts.length > 0 || removedGlitters.length > 0) {
        eraseHistory.current.push({ patches, texts: removedTexts, glitters: removedGlitters })
        committed = true
        let bytes = eraseHistory.current.reduce((n, g) => n + entryBytes(g), 0)
        while (
          eraseHistory.current.length > MAX_UNDO ||
          (bytes > MAX_UNDO_BYTES && eraseHistory.current.length > 1)
        ) {
          bytes -= entryBytes(eraseHistory.current.shift()!)
        }
      }
      maskCtx().clearRect(0, 0, dims.w, dims.h)
      maskStrokes.current = []
      setMaskActions(0)
      setDetectResult(null)
      setEraseCount((n) => n + 1)
    } catch (err) {
      // Undo whatever this attempt already applied before it threw: the
      // overlay items were removed from hook state and the patches were
      // painted onto the canvas up top, and neither made it into
      // eraseHistory, so nothing else will ever put them back. This does
      // NOT replay the mask — the strokes that were dropped to make room
      // for the overlay-item removal are mutated in place and out of scope
      // to reconstruct; only the pixels and the overlay items are restored.
      // Skipped once `committed` is true: from that point the work is in
      // eraseHistory and `undo` owns reversing it, so rolling back here too
      // would double-restore.
      if (!committed) {
        if (patches.length > 0) {
          const ctx = imgCanvasRef.current!.getContext('2d')!
          for (let i = patches.length - 1; i >= 0; i--) {
            ctx.putImageData(patches[i].data, patches[i].x, patches[i].y)
          }
        }
        addBackText(removedTexts)
        addBackGlitter(removedGlitters)
      }
      console.error(err)
      setError('Inpainting failed — try a smaller image or reload.')
      track('erase-error')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [
    dims,
    eraseCount,
    onModelProgress,
    removeCoveredText,
    removeCoveredGlitter,
    addBackText,
    addBackGlitter,
  ])

  const erase = useCallback(() => {
    if (maskActions === 0) return
    void runErase()
  }, [maskActions, runErase])

  const enterCrop = () => {
    if (busy || !dims || maskActions !== 0) return
    cropRectRef.current = { x: 0, y: 0, w: dims.w, h: dims.h }
    setCropping(true)
    track('crop-open')
  }

  const enterText = () => {
    if (busy || !dims || cropping) return
    setCursor(null)
    setTool('text')
    if (textTool.items.length === 0) textTool.addItem()
    track('text-open')
  }

  const exitText = () => {
    // Commit any in-progress inline edit (blur fires its commit handler)
    // before the overlay unmounts, so typed text isn't lost.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    textTool.deselect()
    setTool('erase')
  }

  const enterGlitter = () => {
    if (busy || !dims || cropping) return
    setCursor(null)
    setTool('glitter')
    track('glitter-open')
  }

  const exitGlitter = () => {
    glitterTool.deselect()
    setTool('erase')
  }

  // Adding/switching items also goes through blur-first so the current
  // inline edit commits before the editor moves to another item.
  const addTextItem = () => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    textTool.addItem()
  }

  const cancelCrop = () => {
    setCropping(false)
  }

  const applyCrop = () => {
    if (busy || !dims || maskActions !== 0) return
    const rect = cropRectRef.current
    // No-op guards: full-image or degenerate selection.
    if (rect.w < 1 || rect.h < 1 || (rect.w >= dims.w && rect.h >= dims.h)) {
      setCropping(false)
      return
    }

    const imgCanvas = imgCanvasRef.current!
    const origCanvas = origCanvasRef.current!
    const maskCanvas = maskCanvasRef.current!
    const imgCtx = imgCanvas.getContext('2d', { willReadFrequently: true })!
    const origCtx = origCanvas.getContext('2d', { willReadFrequently: true })!

    // Keep an undo snapshot only if the pre-crop pixels (two full planes) plus
    // the current erase-undo stack fit under the shared memory cap. On large
    // images this usually won't fit, so the crop is final — matching the
    // editor's existing "don't retain full-frame pixels on mobile" policy.
    const planeBytes = dims.w * dims.h * 4 * 2
    const histBytes = eraseHistory.current.reduce((n, g) => n + entryBytes(g), 0)
    if (planeBytes + histBytes <= MAX_UNDO_BYTES) {
      cropUndo.current = {
        dims: { w: dims.w, h: dims.h },
        image: imgCtx.getImageData(0, 0, dims.w, dims.h),
        orig: origCtx.getImageData(0, 0, dims.w, dims.h),
        eraseHistory: eraseHistory.current.slice(),
        eraseCountBefore: eraseCount,
        textItems: textTool.items,
        glitterItems: glitterTool.items,
      }
      setCropUndoAvailable(true)
    } else {
      cropUndo.current = null
      setCropUndoAvailable(false)
    }

    // Crop each canvas via a scratch canvas — canvas-to-canvas drawImage, no
    // extra full-frame JS array beyond the optional snapshot above.
    const scratch = document.createElement('canvas')
    scratch.width = rect.w
    scratch.height = rect.h
    const sctx = scratch.getContext('2d')!
    for (const [canvas, ctx] of [
      [imgCanvas, imgCtx],
      [origCanvas, origCtx],
    ] as const) {
      sctx.clearRect(0, 0, rect.w, rect.h)
      sctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
      canvas.width = rect.w
      canvas.height = rect.h
      ctx.drawImage(scratch, 0, 0)
    }
    maskCanvas.width = rect.w
    maskCanvas.height = rect.h
    textCanvasRef.current!.width = rect.w
    textCanvasRef.current!.height = rect.h
    glitterCanvasRef.current!.width = rect.w
    glitterCanvasRef.current!.height = rect.h

    maskStrokes.current = []
    eraseHistory.current = []
    textTool.applyCrop(rect)
    glitterTool.applyCrop(rect)
    setMaskActions(0)
    setEraseCount(0)
    setDims({ w: rect.w, h: rect.h })
    setCropping(false)
    track('crop', { w: rect.w, h: rect.h })
  }

  const download = async () => {
    track('download', {
      erases: eraseCount,
      texts: textTool.items.length,
      glitters: glitterTool.items.length,
    })
    const token = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('')
    let source: HTMLCanvasElement = imgCanvasRef.current!
    if (textTool.items.length > 0 || glitterTool.items.length > 0) {
      // Composite the overlays into the export (they never touch the working
      // canvas, so they stay editable after saving). Sparkles draw last so
      // they sit on top of a caption, matching the on-screen layering.
      await loadFontsFor(textTool.items)
      const scratch = document.createElement('canvas')
      scratch.width = source.width
      scratch.height = source.height
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(source, 0, 0)
      drawTextItems(ctx, textTool.items)
      drawGlitterItems(ctx, glitterTool.items)
      source = scratch
    }
    source.toBlob((blob) => {
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
      // Never hijack keys while the user is typing (text-tool inputs).
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)
      )
        return
      if (tool === 'glitter') {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault()
          glitterTool.undoLast()
        }
        return
      }
      if (tool !== 'erase') return
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
  }, [busy, dims, cropping, tool])

  const hasEdit =
    eraseCount > 0 ||
    textTool.items.length > 0 ||
    glitterTool.items.length > 0 ||
    (dims !== null &&
      originalDims !== null &&
      (dims.w !== originalDims.w || dims.h !== originalDims.h))

  const status = cropping
    ? 'drag to select the area to keep'
    : tool === 'glitter'
    ? glitterTool.items.length === 0
      ? 'tap the image to add sparkle'
      : 'tap to add more — drag a sparkle to move it'
    : tool === 'text'
    ? textTool.editing
      ? 'type your text — tap outside when finished'
      : textTool.selected
        ? 'drag to position — double-tap to edit the words'
        : textTool.items.length > 0
          ? 'tap text on the image to select it, or add another'
          : 'tap + add text to place a caption'
    : busy
    ? 'erasing…'
    : detectResult === 'found'
      ? 'watermark detected — press erase'
      : detectResult === 'none'
        ? 'no watermark detected — brush over it manually'
        : eraseCount > 0
          ? 'erased — brush over anything else, or save your image'
          : model.state === 'error'
            ? 'model unavailable'
            : model.state === 'ready'
              ? 'tap ✦ detect to find the watermark, or brush over anything — then erase'
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
          ref={imgBoxRef}
          className="relative"
          style={{ width: fit.w || undefined, height: fit.h || undefined, willChange: 'transform' }}
        >
          <canvas
            ref={imgCanvasRef}
            className="absolute inset-0 w-full h-full"
            style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.55)' }}
          />
          {/* text overlay — under the compare plane so "original" hides it */}
          <canvas ref={textCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
          {/* glitter overlay — above text so a sparkle can sit on a caption,
              still under the compare plane so "original" hides it */}
          <canvas ref={glitterCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
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
            onPointerUp={(e) => {
              view.onPointerUp(e)
              endStroke()
            }}
            onPointerCancel={(e) => {
              view.onPointerUp(e)
              endStroke()
            }}
            onPointerLeave={(e) => {
              view.onPointerUp(e)
              endStroke()
              setCursor(null)
            }}
          />
          {cropping && dims && fit.w > 0 && (
            <CropOverlay
              natural={dims}
              display={fit}
              onChange={(r) => {
                cropRectRef.current = r
              }}
            />
          )}
          {/* inline text editor — type with a real caret in place; the
              canvas skips this item while it's mounted. */}
          {tool === 'text' && textTool.editing && dims && (
            <TextEditOverlay
              key={textTool.editing.id}
              item={textTool.editing}
              scale={displayScale}
              onCommit={textTool.commitEditing}
            />
          )}
          {/* text selection ring — in the container's local space, so it
              tracks the item through zoom/pan like the canvases do. */}
          {tool === 'text' && textTool.selected && !textTool.editing && dims && (() => {
            const b = measureTextItem(textTool.selected)
            return (
              <div
                aria-hidden
                className="absolute pointer-events-none border border-dashed"
                style={{
                  left: b.x / displayScale - 4,
                  top: b.y / displayScale - 4,
                  width: b.w / displayScale + 8,
                  height: b.h / displayScale + 8,
                  borderColor: 'var(--amber-soft)',
                }}
              />
            )
          })()}
          {/* glitter selection ring — local space, so it tracks the sparkle
              through zoom/pan like the canvases do. */}
          {tool === 'glitter' && glitterTool.selected && dims && (() => {
            const b = measureGlitterItem(glitterTool.selected)
            return (
              <div
                aria-hidden
                className="absolute pointer-events-none border border-dashed rounded-full"
                style={{
                  left: b.x / displayScale - 4,
                  top: b.y / displayScale - 4,
                  width: b.w / displayScale + 8,
                  height: b.h / displayScale + 8,
                  borderColor: 'var(--amber-soft)',
                }}
              />
            )
          })()}
          {/* brush cursor — sized in the container's local space so it stays a
              constant on-screen size after the transform scales it. */}
          {cursor && !busy && !cropping && tool === 'erase' && (
            <div
              aria-hidden
              className="absolute pointer-events-none rounded-full border"
              style={{
                left: cursor.x - brush / cursor.z / 2,
                top: cursor.y - brush / cursor.z / 2,
                width: brush / cursor.z,
                height: brush / cursor.z,
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
        {!cropping && view.zoomPct > 100 && (
          <ZoomControls
            pct={view.zoomPct}
            onZoomOut={view.zoomOut}
            onZoomIn={view.zoomIn}
            onFit={view.fit}
          />
        )}
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
      <div className="px-6 pb-1.5 sm:pb-2 flex justify-center">
        <span
          className="label text-center"
          style={{
            color: error
              ? '#d96c47'
              : (eraseCount > 0 || detectResult === 'found') && !busy
                ? 'var(--amber)'
                : 'var(--ink-faint)',
          }}
        >
          {error ?? status}
        </span>
      </div>

      {/* toolbar */}
      {cropping ? (
        <div className="px-3 sm:px-6 pb-3 sm:pb-6 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={cancelCrop}
          >
            cancel
          </button>
          <button
            type="button"
            onClick={applyCrop}
            className="label px-6 sm:px-7 h-9 sm:h-10 cursor-pointer transition-colors duration-150"
            style={{ background: 'var(--amber)', color: '#181612', fontWeight: 500 }}
          >
            apply
          </button>
        </div>
      ) : tool === 'text' ? (
        <TextControls
          selected={textTool.selected}
          editing={textTool.editing !== null}
          onUpdate={textTool.updateSelected}
          onAdd={addTextItem}
          onEdit={() => textTool.selected && textTool.startEditing(textTool.selected.id)}
          onDelete={textTool.deleteSelected}
          onDone={exitText}
        />
      ) : tool === 'glitter' ? (
        <GlitterControls
          draft={glitterTool.draft}
          selected={glitterTool.selected}
          hasItems={glitterTool.items.length > 0}
          maxSize={dims ? Math.max(400, Math.round(dims.w / 3)) : 400}
          onDraftChange={glitterTool.setDraftValue}
          onUndo={glitterTool.undoLast}
          onDelete={glitterTool.deleteSelected}
          onDone={exitGlitter}
        />
      ) : (
        <div className="px-3 sm:px-6 pb-3 sm:pb-6 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
          <div className="ctrl flex items-center gap-2 sm:gap-3 px-3 sm:px-4 h-9 sm:h-10">
            <span className="label">brush</span>
            <input
              type="range"
              min={8}
              max={96}
              value={brush}
              onChange={(e) => setBrush(Number(e.target.value))}
              className="w-20 sm:w-24"
              aria-label="Brush size"
            />
          </div>
          <button type="button" className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer" onClick={detectPressed} disabled={busy}>
            ✦ detect
          </button>
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={enterCrop}
            disabled={busy || maskActions !== 0}
          >
            cut
          </button>
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={enterText}
            disabled={busy}
          >
            text
          </button>
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={enterGlitter}
            disabled={busy}
          >
            glitter
          </button>
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={undo}
            disabled={busy || (maskActions === 0 && eraseCount === 0 && !cropUndoAvailable)}
          >
            undo
          </button>
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={clearMask}
            disabled={busy || maskActions === 0}
          >
            clear
          </button>
          <button
            type="button"
            onClick={erase}
            disabled={busy || maskActions === 0 || model.state === 'error'}
            className="label px-6 sm:px-7 h-9 sm:h-10 cursor-pointer transition-colors duration-150 disabled:opacity-35 disabled:cursor-not-allowed"
            style={{
              background: 'var(--amber)',
              color: '#181612',
              fontWeight: 500,
            }}
          >
            {busy ? 'working' : 'erase'}
          </button>
          <span aria-hidden className="hidden sm:block w-px h-6 mx-2" style={{ background: 'var(--line)' }} />
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer select-none"
            data-active={comparing}
            disabled={!hasEdit}
            onPointerDown={() => {
              track('compare')
              setComparing(true)
            }}
            onPointerUp={() => setComparing(false)}
            onPointerLeave={() => setComparing(false)}
          >
            <span className="hidden sm:inline">hold to </span>compare
          </button>
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={download}
            disabled={busy || !hasEdit}
          >
            save png
          </button>
          <button
            type="button"
            className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer"
            onClick={() => {
              track('replace-image')
              onReplace()
            }}
            disabled={busy}
          >
            new image
          </button>
        </div>
      )}
    </div>
  )
}

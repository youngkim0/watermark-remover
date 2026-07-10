// Text overlay items: drawn onto a canvas with the same routine for the live
// preview and the exported PNG, so what you see is exactly what you save.
import { fontById, type FontId } from '@/lib/fonts'

export type TextItem = {
  id: number
  text: string // may contain newlines
  x: number // natural px, center anchor
  y: number
  size: number // natural px font size
  fontId: FontId
  weight: number
  color: string
}

export const LINE_HEIGHT = 1.25

function fontSpec(item: TextItem): string {
  return `${item.weight} ${item.size}px ${fontById(item.fontId).family}`
}

export function drawTextItems(ctx: CanvasRenderingContext2D, items: TextItem[]) {
  for (const item of items) {
    ctx.font = fontSpec(item)
    ctx.fillStyle = item.color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const lines = item.text.split('\n')
    const lh = item.size * LINE_HEIGHT
    const y0 = item.y - ((lines.length - 1) / 2) * lh
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], item.x, y0 + i * lh)
    }
  }
}

let measureCtx: CanvasRenderingContext2D | null = null

/** Bounding box (natural px) of an item, for hit-testing and selection UI. */
export function measureTextItem(item: TextItem): { x: number; y: number; w: number; h: number } {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')!
  }
  measureCtx.font = fontSpec(item)
  const lines = item.text.split('\n')
  let w = 0
  for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width)
  const h = Math.max(1, lines.length) * item.size * LINE_HEIGHT
  // A comfortable minimum so empty/short items stay tappable.
  w = Math.max(w, item.size)
  return { x: item.x - w / 2, y: item.y - h / 2, w, h }
}

/**
 * Load the font faces the items need. Passing each item's actual text makes
 * the browser fetch only the unicode-range slices it requires — Korean glyph
 * slices download on demand instead of the whole multi-MB font.
 */
export function loadFontsFor(items: TextItem[]): Promise<unknown> {
  if (items.length === 0 || typeof document === 'undefined') return Promise.resolve()
  return Promise.all(
    items.map((item) =>
      document.fonts.load(fontSpec(item), item.text || 'Aa').catch(() => undefined)
    )
  )
}

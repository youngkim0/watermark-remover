// Text-tool fonts. Every family covers Hangul + Latin so Korean input works
// regardless of style choice. next/font downloads at build time and
// self-hosts — no runtime Google request, which also keeps the site's
// COEP: require-corp header (WASM isolation) out of the picture.
// preload: false — the files load lazily, only once the text tool uses them.
import {
  Noto_Sans_KR,
  Noto_Serif_KR,
  Black_Han_Sans,
  Do_Hyeon,
  Jua,
  Nanum_Pen_Script,
} from 'next/font/google'

const notoSans = Noto_Sans_KR({ weight: ['400', '700'], preload: false })
const notoSerif = Noto_Serif_KR({ weight: ['400', '700'], preload: false })
const blackHan = Black_Han_Sans({ weight: '400', preload: false })
const doHyeon = Do_Hyeon({ weight: '400', preload: false })
const jua = Jua({ weight: '400', preload: false })
const nanumPen = Nanum_Pen_Script({ weight: '400', preload: false })

export type FontId = 'sans' | 'serif' | 'black' | 'display' | 'round' | 'hand'

export type TextFont = {
  id: FontId
  label: string
  /** CSS font-family value — valid in both DOM styles and ctx.font. */
  family: string
  /** Weights the family actually ships (no synthetic bold on canvas). */
  weights: number[]
}

export const TEXT_FONTS: TextFont[] = [
  { id: 'sans', label: 'Sans', family: notoSans.style.fontFamily, weights: [400, 700] },
  { id: 'serif', label: 'Serif', family: notoSerif.style.fontFamily, weights: [400, 700] },
  { id: 'black', label: 'Black', family: blackHan.style.fontFamily, weights: [400] },
  { id: 'display', label: 'Display', family: doHyeon.style.fontFamily, weights: [400] },
  { id: 'round', label: 'Round', family: jua.style.fontFamily, weights: [400] },
  { id: 'hand', label: 'Hand', family: nanumPen.style.fontFamily, weights: [400] },
]

export function fontById(id: FontId): TextFont {
  return TEXT_FONTS.find((f) => f.id === id) ?? TEXT_FONTS[0]
}

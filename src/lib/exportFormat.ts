export type ExportFormat = 'png' | 'jpeg' | 'webp'

export type ExportPrefs = { format: ExportFormat; quality: number }

export const EXPORT_FORMATS: { id: ExportFormat; label: string; mime: string; ext: string }[] = [
  { id: 'png', label: 'png', mime: 'image/png', ext: 'png' },
  { id: 'jpeg', label: 'jpg', mime: 'image/jpeg', ext: 'jpg' },
  { id: 'webp', label: 'webp', mime: 'image/webp', ext: 'webp' },
]

export const formatInfo = (f: ExportFormat) => EXPORT_FORMATS.find((x) => x.id === f)!

const DEFAULT_PREFS: ExportPrefs = { format: 'png', quality: 90 }
const PREFS_KEY = 'unmark.export'

/** The last format/quality the viewer saved with. Storage can be missing or
 *  throw (private mode, blocked site data), so fall back to the defaults. */
export function loadExportPrefs(): ExportPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null')
    if (
      raw &&
      EXPORT_FORMATS.some((f) => f.id === raw.format) &&
      typeof raw.quality === 'number' &&
      raw.quality >= 10 &&
      raw.quality <= 100
    ) {
      return { format: raw.format, quality: Math.round(raw.quality) }
    }
  } catch {}
  return DEFAULT_PREFS
}

export function saveExportPrefs(p: ExportPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {}
}

let webpSupport: boolean | null = null

/** Safari can't encode WebP from a canvas — toBlob silently hands back a PNG
 *  instead — so the option is only offered where the encoder really exists. */
export function canEncodeWebp(): boolean {
  if (webpSupport === null) {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    webpSupport = c.toDataURL('image/webp').startsWith('data:image/webp')
  }
  return webpSupport
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

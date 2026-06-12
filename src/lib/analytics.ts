type EventData = Record<string, string | number | boolean>

declare global {
  interface Window {
    umami?: { track: (event: string, data?: EventData) => void }
  }
}

/**
 * Send a custom event to Umami. No-ops when the script isn't loaded
 * (env var unset, ad blocker, SSR). Never include image content,
 * filenames, or pixel data — names, counts, and durations only.
 */
export function track(event: string, data?: EventData) {
  if (typeof window === 'undefined') return
  window.umami?.track(event, data)
}

// Whole-image tone/detail adjustment: the values the sliders hold and the
// shader parameters they map to. Kept separate from the renderer so the math
// is readable without any WebGL around it.

/** Both in −100..100; {0, 0} is "no adjustment". */
export type Adjust = { sharp: number; light: number }

export const NEUTRAL_ADJUST: Adjust = { sharp: 0, light: 0 }

export const isNeutralAdjust = (a: Adjust) => a.sharp === 0 && a.light === 0

export const sameAdjust = (a: Adjust, b: Adjust) => a.sharp === b.sharp && a.light === b.light

export type AdjustParams = {
  /** Gaussian σ in natural px; 0 skips the blur passes. */
  sigma: number
  /** 'blur' outputs the blurred image; 'sharpen' an unsharp mask. */
  mode: 'none' | 'blur' | 'sharpen'
  /** Unsharp strength (sharpen mode only). */
  amount: number
  /** sRGB gamma exponent: <1 brightens midtones, >1 darkens. */
  gamma: number
}

// Blur sigma is relative to the image's long side so a phone photo and a
// thumbnail blur alike at the same slider position.
const MAX_BLUR_FRACTION = 1 / 150
const SHARPEN_FRACTION = 1 / 2000
const MAX_SHARPEN_AMOUNT = 1.5
// Below this a Gaussian is a no-op at 8 bits.
const MIN_SIGMA = 0.3

export function adjustParams(a: Adjust, d: { w: number; h: number }): AdjustParams {
  const long = Math.max(d.w, d.h)
  const gamma = Math.pow(2, -a.light / 100)
  if (a.sharp < 0) {
    // The 1.5 power spends the first half of the slider on subtle softening.
    const sigma = long * MAX_BLUR_FRACTION * Math.pow(-a.sharp / 100, 1.5)
    if (sigma >= MIN_SIGMA) return { sigma, mode: 'blur', amount: 0, gamma }
  } else if (a.sharp > 0) {
    const sigma = Math.max(1, long * SHARPEN_FRACTION)
    return { sigma, mode: 'sharpen', amount: (MAX_SHARPEN_AMOUNT * a.sharp) / 100, gamma }
  }
  return { sigma: 0, mode: 'none', amount: 0, gamma }
}

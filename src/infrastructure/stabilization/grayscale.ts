/**
 * Luma extraction and the image pyramid the tracker walks.
 *
 * Analysis runs on luminance at a reduced resolution: camera motion is a global, low-frequency
 * signal, and estimating it from a 4K frame costs sixteen times what a 960px one costs while
 * moving the answer by a fraction of a pixel. The transform that comes out is scale-free, so it
 * applies to the full-resolution frame unchanged.
 */

import type { GrayImage } from './types'

/** Rec. 709 luma weights — the same primaries the footage was encoded against. */
const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

export function rgbaToLuma(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  const data = new Float32Array(width * height)
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = LUMA_R * rgba[p]! + LUMA_G * rgba[p + 1]! + LUMA_B * rgba[p + 2]!
  }
  return { data, width, height }
}

/**
 * Half-size copy via a 2x2 box filter.
 *
 * The box doubles as the anti-alias prefilter. Point-sampling instead would alias high-frequency
 * texture into the coarse levels, and the tracker would chase that aliasing as if it were motion.
 */
export function downsampleByTwo(image: GrayImage): GrayImage {
  const width = Math.max(1, image.width >> 1)
  const height = Math.max(1, image.height >> 1)
  const data = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    const y0 = Math.min(y * 2, image.height - 1)
    const y1 = Math.min(y * 2 + 1, image.height - 1)
    const row0 = y0 * image.width
    const row1 = y1 * image.width
    for (let x = 0; x < width; x++) {
      const x0 = Math.min(x * 2, image.width - 1)
      const x1 = Math.min(x * 2 + 1, image.width - 1)
      data[y * width + x] =
        (image.data[row0 + x0]! +
          image.data[row0 + x1]! +
          image.data[row1 + x0]! +
          image.data[row1 + x1]!) *
        0.25
    }
  }
  return { data, width, height }
}

/**
 * Coarse-to-fine pyramid, index 0 being full size.
 *
 * Levels stop once a side drops below `minSide`: below that the whole frame is a handful of
 * texels, every window covers most of the image, and the level contributes noise rather than a
 * usable coarse estimate.
 */
export function buildPyramid(image: GrayImage, levels: number, minSide = 24): GrayImage[] {
  const pyramid: GrayImage[] = [image]
  for (let level = 1; level < levels; level++) {
    const previous = pyramid[level - 1]!
    if (previous.width <= minSide || previous.height <= minSide) break
    pyramid.push(downsampleByTwo(previous))
  }
  return pyramid
}

/**
 * Bilinear sample with edge clamping.
 *
 * Clamping rather than rejecting: the tracker routinely probes a window that hangs a pixel or two
 * off the frame, and dropping those features would blind it to exactly the border regions where
 * large motions are most visible.
 */
export function sampleBilinear(image: GrayImage, x: number, y: number): number {
  const { data, width, height } = image
  const clampedX = Math.min(Math.max(x, 0), width - 1)
  const clampedY = Math.min(Math.max(y, 0), height - 1)
  const x0 = Math.floor(clampedX)
  const y0 = Math.floor(clampedY)
  const x1 = Math.min(x0 + 1, width - 1)
  const y1 = Math.min(y0 + 1, height - 1)
  const fx = clampedX - x0
  const fy = clampedY - y0

  const top = data[y0 * width + x0]! * (1 - fx) + data[y0 * width + x1]! * fx
  const bottom = data[y1 * width + x0]! * (1 - fx) + data[y1 * width + x1]! * fx
  return top * (1 - fy) + bottom * fy
}

/**
 * Longest side of the analysis image. Chosen over "always downscale by N" because the tracker's
 * window size and displacement limits are expressed in pixels: normalizing the working resolution
 * keeps one set of thresholds valid for every source, from 480p to 4K.
 */
const ANALYSIS_LONG_SIDE = 960

/** Analysis dimensions for a source frame, never upscaling a small source. */
export function analysisSize(
  width: number,
  height: number,
  longSide = ANALYSIS_LONG_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= longSide) return { width, height }
  const factor = longSide / longest
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  }
}

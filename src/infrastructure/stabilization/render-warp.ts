/**
 * Turning a planned warp into a 2D canvas transform.
 *
 * The plan is expressed in center-origin pixels at the analysis resolution; the render happens at
 * full resolution with a top-left origin. Both conversions are folded into one matrix here so the
 * render loop never has to reason about coordinate systems, and so the conversion is testable
 * without a canvas.
 */

import type { SimilarityTransform } from './types'

/** A `setTransform(a, b, c, d, e, f)` argument list. */
export interface CanvasMatrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/**
 * Compose: recenter, apply the warp, zoom past the exposed borders, return to a top-left origin.
 *
 * `pixelScale` is the ratio of render width to analysis width. Rotation and scale are
 * dimensionless and carry over untouched; only the translation has to be rescaled.
 */
export function warpToCanvasMatrix(
  warp: SimilarityTransform,
  cropRatio: number,
  width: number,
  height: number,
  pixelScale: number,
): CanvasMatrix {
  const zoom = 1 / cropRatio
  const linear = zoom * warp.scale
  const cos = Math.cos(warp.rotation) * linear
  const sin = Math.sin(warp.rotation) * linear
  const centerX = width / 2
  const centerY = height / 2

  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: centerX + zoom * warp.translateX * pixelScale - (cos * centerX - sin * centerY),
    f: centerY + zoom * warp.translateY * pixelScale - (sin * centerX + cos * centerY),
  }
}

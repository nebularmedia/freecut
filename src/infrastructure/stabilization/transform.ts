/**
 * Similarity transform algebra.
 *
 * Everything downstream — path accumulation, smoothing, the final warp — is built from compose and
 * invert, so these are kept exact rather than approximated by 3x3 matrix multiplication. Keeping
 * rotation and scale as their own scalars also means the smoother can operate on angle and
 * log-scale directly, where a matrix form would force it to smooth four coupled entries and drift
 * off the similarity manifold.
 */

import type { Point, SimilarityTransform } from './types'

export function applyTransform(transform: SimilarityTransform, point: Point): Point {
  const cos = Math.cos(transform.rotation) * transform.scale
  const sin = Math.sin(transform.rotation) * transform.scale
  return {
    x: cos * point.x - sin * point.y + transform.translateX,
    y: sin * point.x + cos * point.y + transform.translateY,
  }
}

/** `compose(a, b)` applies `b` first, then `a`. */
export function composeTransforms(
  a: SimilarityTransform,
  b: SimilarityTransform,
): SimilarityTransform {
  const cos = Math.cos(a.rotation) * a.scale
  const sin = Math.sin(a.rotation) * a.scale
  return {
    rotation: a.rotation + b.rotation,
    scale: a.scale * b.scale,
    translateX: cos * b.translateX - sin * b.translateY + a.translateX,
    translateY: sin * b.translateX + cos * b.translateY + a.translateY,
  }
}

export function invertTransform(transform: SimilarityTransform): SimilarityTransform {
  const inverseScale = 1 / transform.scale
  const cos = Math.cos(-transform.rotation) * inverseScale
  const sin = Math.sin(-transform.rotation) * inverseScale
  return {
    rotation: -transform.rotation,
    scale: inverseScale,
    translateX: -(cos * transform.translateX - sin * transform.translateY),
    translateY: -(sin * transform.translateX + cos * transform.translateY),
  }
}

/**
 * Rebuild a transform around a different origin.
 *
 * The estimator works with the image origin at the top-left because that is where pixel
 * coordinates live, while a warp reads far more naturally about the frame center — a rotation
 * around the corner of a 1080p frame carries a translation of hundreds of pixels that has nothing
 * to do with the camera panning.
 */
export function recenterTransform(
  transform: SimilarityTransform,
  originX: number,
  originY: number,
): SimilarityTransform {
  const cos = Math.cos(transform.rotation) * transform.scale
  const sin = Math.sin(transform.rotation) * transform.scale
  return {
    rotation: transform.rotation,
    scale: transform.scale,
    translateX: transform.translateX + cos * originX - sin * originY - originX,
    translateY: transform.translateY + sin * originX + cos * originY - originY,
  }
}

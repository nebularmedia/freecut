/**
 * Keeping the crop window inside the frame.
 *
 * Stabilization buys steadiness with framing: holding the virtual camera still while the real one
 * moved means the output has to be drawn from a window that slides around inside the source, and
 * the window can only slide as far as the border allows. Every stabilizer therefore zooms in to
 * create that border, and the zoom is the whole cost of the feature.
 *
 * The budget handed to the smoother keeps almost every frame inside that border. This module is
 * the guarantee behind it: an exact geometric test per frame, and a graceful way to give motion
 * back on the few frames where the shot moved further than the border can absorb. Giving it back
 * gradually is what keeps that concession invisible — an abrupt return to the shaky path reads as
 * a glitch, which is far more noticeable than the shake it was correcting.
 */

import { invertTransform } from './transform'
import type { Point, SimilarityTransform } from './types'

/** Corners of the centered output window, in source-frame pixels. */
export function cropCorners(width: number, height: number, cropRatio: number): Point[] {
  const insetX = (width * (1 - cropRatio)) / 2
  const insetY = (height * (1 - cropRatio)) / 2
  return [
    { x: insetX, y: insetY },
    { x: width - insetX, y: insetY },
    { x: width - insetX, y: height - insetY },
    { x: insetX, y: height - insetY },
  ]
}

/**
 * True when every pixel the output needs exists in the source.
 *
 * `warp` maps source content to its stabilized position, so pulling the crop window back through
 * its inverse gives the source region the output will read from. A similarity maps a rectangle to
 * a rectangle, so testing the four corners against the frame is exact, not an approximation.
 */
export function warpCoversCrop(
  warp: SimilarityTransform,
  width: number,
  height: number,
  cropRatio: number,
): boolean {
  const inverse = invertTransform(warp)
  const cos = Math.cos(inverse.rotation) * inverse.scale
  const sin = Math.sin(inverse.rotation) * inverse.scale
  for (const corner of cropCorners(width, height, cropRatio)) {
    const x = cos * corner.x - sin * corner.y + inverse.translateX
    const y = sin * corner.x + cos * corner.y + inverse.translateY
    if (x < 0 || y < 0 || x > width || y > height) return false
  }
  return true
}

/**
 * Scale a correction back toward doing nothing. At 1 the frame is fully stabilized; at 0 it is the
 * original, shaky frame. Rotation and log-scale are interpolated rather than the scale factor
 * itself, so half of a 2x zoom is 1.41x and not 1.5x — the wrong midpoint would show up as a
 * lurch in the middle of an attenuated stretch.
 */
export function attenuateWarp(warp: SimilarityTransform, factor: number): SimilarityTransform {
  return {
    rotation: warp.rotation * factor,
    scale: Math.exp(Math.log(warp.scale) * factor),
    translateX: warp.translateX * factor,
    translateY: warp.translateY * factor,
  }
}

/**
 * Largest attenuation factor whose warp still covers the crop window.
 *
 * Bisection rather than a closed form: the constraint is the intersection of four corner
 * inequalities under a transform whose rotation and scale both vary with the factor, and twelve
 * halvings land within a thousandth of the true limit for a fraction of the cost of getting the
 * algebra right.
 */
export function maxCoveringFactor(
  warp: SimilarityTransform,
  width: number,
  height: number,
  cropRatio: number,
  steps = 12,
): number {
  if (warpCoversCrop(warp, width, height, cropRatio)) return 1

  let low = 0
  let high = 1
  for (let step = 0; step < steps; step++) {
    const middle = (low + high) / 2
    if (warpCoversCrop(attenuateWarp(warp, middle), width, height, cropRatio)) {
      low = middle
    } else {
      high = middle
    }
  }
  return low
}

/**
 * Spread each frame's attenuation limit over its neighbors so the concession eases in and out.
 *
 * Two passes, and the order matters. The min-filter first pulls every frame down to the strictest
 * limit nearby, which is what makes the blur that follows safe — blurring alone would lift a
 * frame above its own limit and break the guarantee. The final clamp re-imposes each frame's limit
 * for the same reason.
 */
export function smoothAttenuation(limits: Float64Array, radius: number): Float64Array {
  const size = limits.length
  if (size === 0 || radius <= 0) return new Float64Array(limits)

  const eroded = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    let lowest = limits[i]!
    for (let k = Math.max(0, i - radius); k <= Math.min(size - 1, i + radius); k++) {
      if (limits[k]! < lowest) lowest = limits[k]!
    }
    eroded[i] = lowest
  }

  const smoothed = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    let total = 0
    let weightSum = 0
    for (let k = Math.max(0, i - radius); k <= Math.min(size - 1, i + radius); k++) {
      // Triangular window: cheap, strictly positive, and smooth enough that no residual step
      // survives into the render.
      const weight = radius + 1 - Math.abs(k - i)
      total += eroded[k]! * weight
      weightSum += weight
    }
    smoothed[i] = Math.min(total / weightSum, limits[i]!)
  }
  return smoothed
}

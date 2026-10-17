/**
 * Pyramidal Lucas-Kanade feature tracking.
 *
 * Lucas-Kanade solves for the displacement that best explains the brightness difference over a
 * small window, which only holds while that displacement is smaller than the window. Handheld
 * footage routinely moves twenty pixels between frames, so the solve runs coarse-to-fine: at
 * 1/8 resolution a twenty-pixel jump is under three pixels and well inside the window, and each
 * finer level refines the estimate the level above handed down.
 *
 * Every surviving track is verified by re-tracking it backwards. A window on repetitive texture —
 * railings, brickwork, ripples — will lock confidently onto the wrong period and produce a
 * consistent, plausible, wrong displacement that no outlier test on the motion model can catch,
 * because several such features agree with each other. Backward tracking catches it: the wrong
 * match does not lead home.
 */

import { sampleBilinear } from './grayscale'
import type { GrayImage, Point, TrackedPair } from './types'

export interface TrackOptions {
  /** Half-width of the correlation window, in pixels. */
  windowRadius?: number
  /** Refinement iterations per pyramid level. */
  iterations?: number
  /** Stop refining once a step moves less than this, in pixels. */
  epsilon?: number
  /** Discard a track whose round trip misses its origin by more than this, in pixels. */
  maxForwardBackwardError?: number
  /**
   * Reject a window whose structure tensor is nearly singular. Scaled by the window's texel count
   * so one threshold holds for any window size.
   */
  minEigenvalue?: number
}

const DEFAULTS: Required<TrackOptions> = {
  windowRadius: 5,
  iterations: 12,
  epsilon: 0.03,
  maxForwardBackwardError: 1,
  minEigenvalue: 0.5,
}

interface WindowGradients {
  /** Structure tensor [[xx, xy], [xy, yy]] summed over the window. */
  xx: number
  xy: number
  yy: number
  /** Column-major samples of the reference patch and its gradients. */
  reference: Float32Array
  gradientX: Float32Array
  gradientY: Float32Array
  determinant: number
  smallestEigenvalue: number
}

/**
 * Reference patch, its spatial gradients and the structure tensor, all sampled once per level.
 *
 * The gradients come from the *reference* frame and stay fixed across the iterations, which is
 * what makes the inverse-compositional form of the solve cheap: the 2x2 matrix is inverted once
 * and only the residual is recomputed.
 */
function sampleWindow(image: GrayImage, cx: number, cy: number, radius: number): WindowGradients {
  const side = radius * 2 + 1
  const count = side * side
  const reference = new Float32Array(count)
  const gradientX = new Float32Array(count)
  const gradientY = new Float32Array(count)
  let xx = 0
  let xy = 0
  let yy = 0

  for (let dy = -radius, i = 0; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++, i++) {
      const x = cx + dx
      const y = cy + dy
      reference[i] = sampleBilinear(image, x, y)
      const gx = (sampleBilinear(image, x + 1, y) - sampleBilinear(image, x - 1, y)) * 0.5
      const gy = (sampleBilinear(image, x, y + 1) - sampleBilinear(image, x, y - 1)) * 0.5
      gradientX[i] = gx
      gradientY[i] = gy
      xx += gx * gx
      xy += gx * gy
      yy += gy * gy
    }
  }

  const determinant = xx * yy - xy * xy
  const half = (xx + yy) * 0.5
  const offset = Math.sqrt(Math.max(0, (xx - yy) * (xx - yy) * 0.25 + xy * xy))
  return {
    xx,
    xy,
    yy,
    reference,
    gradientX,
    gradientY,
    determinant,
    smallestEigenvalue: half - offset,
  }
}

/**
 * Refine a displacement at one pyramid level. Returns null when the window is untrackable — too
 * flat to constrain a solve, or drifted off the frame.
 */
function refineAtLevel(
  reference: GrayImage,
  target: GrayImage,
  point: Point,
  guess: Point,
  options: Required<TrackOptions>,
): Point | null {
  const { windowRadius, iterations, epsilon, minEigenvalue } = options
  const side = windowRadius * 2 + 1
  const texels = side * side

  if (
    point.x < windowRadius ||
    point.y < windowRadius ||
    point.x > reference.width - 1 - windowRadius ||
    point.y > reference.height - 1 - windowRadius
  ) {
    return null
  }

  const window = sampleWindow(reference, point.x, point.y, windowRadius)
  if (window.smallestEigenvalue < minEigenvalue * texels || window.determinant <= 0) return null

  let dx = guess.x
  let dy = guess.y

  for (let iteration = 0; iteration < iterations; iteration++) {
    let bx = 0
    let by = 0
    for (let wy = -windowRadius, i = 0; wy <= windowRadius; wy++) {
      for (let wx = -windowRadius; wx <= windowRadius; wx++, i++) {
        const residual =
          window.reference[i]! - sampleBilinear(target, point.x + dx + wx, point.y + dy + wy)
        bx += residual * window.gradientX[i]!
        by += residual * window.gradientY[i]!
      }
    }

    const stepX = (window.yy * bx - window.xy * by) / window.determinant
    const stepY = (window.xx * by - window.xy * bx) / window.determinant
    if (!Number.isFinite(stepX) || !Number.isFinite(stepY)) return null

    dx += stepX
    dy += stepY

    // A step that flings the window off the frame means the solve has diverged; the residual is
    // being driven by whatever the edge clamp happens to return, not by real correspondence.
    if (
      Math.abs(dx) > reference.width ||
      Math.abs(dy) > reference.height ||
      !Number.isFinite(dx) ||
      !Number.isFinite(dy)
    ) {
      return null
    }
    if (Math.abs(stepX) < epsilon && Math.abs(stepY) < epsilon) break
  }

  return { x: dx, y: dy }
}

/** Track one point through the pyramid. Returns its position in the target frame, or null. */
function trackPoint(
  referencePyramid: GrayImage[],
  targetPyramid: GrayImage[],
  point: Point,
  options: Required<TrackOptions>,
): Point | null {
  const levels = Math.min(referencePyramid.length, targetPyramid.length)
  let displacement: Point = { x: 0, y: 0 }

  for (let level = levels - 1; level >= 0; level--) {
    const scale = 1 / (1 << level)
    const scaledPoint = { x: point.x * scale, y: point.y * scale }
    const refined = refineAtLevel(
      referencePyramid[level]!,
      targetPyramid[level]!,
      scaledPoint,
      displacement,
      options,
    )
    if (!refined) return null
    // Carry the estimate down a level: one pixel here is two pixels below.
    displacement = level === 0 ? refined : { x: refined.x * 2, y: refined.y * 2 }
  }

  return { x: point.x + displacement.x, y: point.y + displacement.y }
}

/**
 * Track every point from one frame to the next, keeping only the correspondences that survive the
 * round trip.
 */
export function trackFeatures(
  referencePyramid: GrayImage[],
  targetPyramid: GrayImage[],
  points: Point[],
  options: TrackOptions = {},
): TrackedPair[] {
  const resolved = { ...DEFAULTS, ...options }
  const errorLimitSquared = resolved.maxForwardBackwardError * resolved.maxForwardBackwardError
  const pairs: TrackedPair[] = []

  for (const point of points) {
    const forward = trackPoint(referencePyramid, targetPyramid, point, resolved)
    if (!forward) continue
    const backward = trackPoint(targetPyramid, referencePyramid, forward, resolved)
    if (!backward) continue

    const dx = backward.x - point.x
    const dy = backward.y - point.y
    if (dx * dx + dy * dy > errorLimitSquared) continue

    pairs.push({ from: point, to: forward })
  }

  return pairs
}

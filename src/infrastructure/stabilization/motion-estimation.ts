/**
 * Fitting one camera motion to a cloud of tracked features.
 *
 * The fit has to be robust, not accurate-on-average. A frame's correspondences always contain a
 * minority that describe something other than the camera: a person walking through shot, a car,
 * leaves in wind, and the occasional feature that latched onto the wrong texture. Least squares
 * over all of them splits the difference between the camera and the moving subject, and the
 * resulting stabilization drags the background around in sympathy with whatever moved. RANSAC
 * instead looks for the single motion that the *largest* group agrees on, which for any ordinary
 * shot is the camera, and reports the rest as outliers.
 */

import type { FrameMotion, Point, SimilarityTransform, TrackedPair } from './types'
import { applyTransform } from './transform'
import { IDENTITY_TRANSFORM } from './types'

export interface MotionEstimationOptions {
  /** Residual under which a correspondence counts as agreeing with the model, in pixels. */
  inlierThreshold?: number
  /** Upper bound on RANSAC rounds; the adaptive stopping rule usually ends it far sooner. */
  maxIterations?: number
  /** Fewest correspondences worth fitting a motion to at all. */
  minCorrespondences?: number
  /** Seed for the sampler, so the same footage always yields the same result. */
  seed?: number
}

const DEFAULTS: Required<MotionEstimationOptions> = {
  inlierThreshold: 2,
  maxIterations: 200,
  minCorrespondences: 8,
  seed: 0x5eed1234,
}

/**
 * xorshift32. The sampler needs speed and repeatability, not statistical quality — and
 * repeatability is the point: re-running a stabilize on the same clip must not produce a subtly
 * different render.
 */
function createRandom(seed: number): () => number {
  let state = seed | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

/**
 * Closed-form least-squares similarity over every supplied pair (Umeyama). Exact for two pairs,
 * which is what makes it usable as both the minimal solver and the final refinement.
 */
export function fitSimilarity(pairs: readonly TrackedPair[]): SimilarityTransform | null {
  const count = pairs.length
  if (count < 2) return null

  let fromX = 0
  let fromY = 0
  let toX = 0
  let toY = 0
  for (const pair of pairs) {
    fromX += pair.from.x
    fromY += pair.from.y
    toX += pair.to.x
    toY += pair.to.y
  }
  fromX /= count
  fromY /= count
  toX /= count
  toY /= count

  // `dot` drives the aligned component, `cross` the perpendicular one; together they are the
  // complex product whose argument is the rotation and whose modulus is the scale.
  let dot = 0
  let cross = 0
  let energy = 0
  for (const pair of pairs) {
    const ax = pair.from.x - fromX
    const ay = pair.from.y - fromY
    const bx = pair.to.x - toX
    const by = pair.to.y - toY
    dot += ax * bx + ay * by
    cross += ax * by - ay * bx
    energy += ax * ax + ay * ay
  }
  // Every feature sat on the same spot: rotation and scale are unobservable, so only the
  // translation between the centroids is real.
  if (energy < 1e-9) {
    return { rotation: 0, scale: 1, translateX: toX - fromX, translateY: toY - fromY }
  }

  const rotation = Math.atan2(cross, dot)
  const scale = Math.hypot(dot, cross) / energy
  const cos = Math.cos(rotation) * scale
  const sin = Math.sin(rotation) * scale
  return {
    rotation,
    scale,
    translateX: toX - (cos * fromX - sin * fromY),
    translateY: toY - (sin * fromX + cos * fromY),
  }
}

function residualSquared(transform: SimilarityTransform, pair: TrackedPair): number {
  const predicted: Point = applyTransform(transform, pair.from)
  const dx = predicted.x - pair.to.x
  const dy = predicted.y - pair.to.y
  return dx * dx + dy * dy
}

function collectInliers(
  transform: SimilarityTransform,
  pairs: readonly TrackedPair[],
  thresholdSquared: number,
): TrackedPair[] {
  return pairs.filter((pair) => residualSquared(transform, pair) <= thresholdSquared)
}

/**
 * Reject a fit that is geometrically absurd before it can win a RANSAC round. Two nearly
 * coincident sample points can produce an exact-but-meaningless similarity with a huge scale
 * factor, and it only takes one such model scoring well by accident to ruin a frame.
 */
function isPlausible(transform: SimilarityTransform): boolean {
  return (
    Number.isFinite(transform.rotation) &&
    Number.isFinite(transform.scale) &&
    Number.isFinite(transform.translateX) &&
    Number.isFinite(transform.translateY) &&
    transform.scale > 0.5 &&
    transform.scale < 2 &&
    Math.abs(transform.rotation) < Math.PI / 4
  )
}

/**
 * Estimate the motion between two frames from their correspondences.
 *
 * A frame with too little to go on returns the identity with zero confidence rather than a guess.
 * That distinction matters downstream: the path builder holds the camera still through an
 * unmeasurable frame, whereas a low-confidence guess would inject a jolt precisely where the
 * footage is already at its worst.
 */
export function estimateMotion(
  pairs: readonly TrackedPair[],
  options: MotionEstimationOptions = {},
): FrameMotion {
  const { inlierThreshold, maxIterations, minCorrespondences, seed } = { ...DEFAULTS, ...options }
  const trackedCount = pairs.length

  if (trackedCount < minCorrespondences) {
    return { transform: IDENTITY_TRANSFORM, confidence: 0, trackedCount, inlierCount: 0 }
  }

  const thresholdSquared = inlierThreshold * inlierThreshold
  const random = createRandom(seed)
  let bestInliers: TrackedPair[] = []
  let iterations = maxIterations

  for (let iteration = 0; iteration < iterations; iteration++) {
    const first = Math.floor(random() * trackedCount)
    let second = Math.floor(random() * trackedCount)
    if (second === first) second = (second + 1) % trackedCount

    const a = pairs[first]!
    const b = pairs[second]!
    // Two samples on top of each other pin down translation and nothing else; the rotation and
    // scale that come out are noise amplified by a near-zero denominator.
    if (Math.hypot(a.from.x - b.from.x, a.from.y - b.from.y) < 1) continue

    const candidate = fitSimilarity([a, b])
    if (!candidate || !isPlausible(candidate)) continue

    const inliers = collectInliers(candidate, pairs, thresholdSquared)
    if (inliers.length <= bestInliers.length) continue
    bestInliers = inliers

    // Adaptive stopping: once a large consensus exists, the odds of a clean two-point sample are
    // high enough that continuing to the iteration cap is pure waste.
    const inlierRatio = inliers.length / trackedCount
    if (inlierRatio > 0.99) {
      iterations = Math.min(iterations, iteration + 1)
      break
    }
    const failureOdds = Math.max(1e-9, 1 - inlierRatio * inlierRatio)
    const needed = Math.ceil(Math.log(0.001) / Math.log(failureOdds))
    iterations = Math.min(iterations, Math.max(iteration + 1, needed))
  }

  if (bestInliers.length < minCorrespondences) {
    return { transform: IDENTITY_TRANSFORM, confidence: 0, trackedCount, inlierCount: 0 }
  }

  // Refit over the consensus, then re-collect: the refined model is more accurate than the
  // two-point one that found the group, so it usually pulls in a few borderline features the
  // minimal fit had just outside the threshold.
  let refined = fitSimilarity(bestInliers) ?? IDENTITY_TRANSFORM
  const grownInliers = collectInliers(refined, pairs, thresholdSquared)
  if (grownInliers.length >= bestInliers.length) {
    bestInliers = grownInliers
    refined = fitSimilarity(grownInliers) ?? refined
  }

  if (!isPlausible(refined)) {
    return { transform: IDENTITY_TRANSFORM, confidence: 0, trackedCount, inlierCount: 0 }
  }

  return {
    transform: refined,
    confidence: bestInliers.length / trackedCount,
    trackedCount,
    inlierCount: bestInliers.length,
  }
}

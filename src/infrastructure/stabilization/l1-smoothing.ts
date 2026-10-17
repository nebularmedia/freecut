/**
 * L1-optimal camera path smoothing.
 *
 * This is what separates a stabilizer that looks professional from one that merely looks calmer.
 * Smoothing the shaky path with a low-pass filter minimizes the *squared* deviation from it, and
 * squared error is minimized by spreading a little residual motion across every frame — so the
 * result still drifts everywhere, just more slowly. It reads as floating.
 *
 * Minimizing the L1 norm of the path's derivatives instead pushes the solution onto a sparse set:
 * almost every frame gets a derivative of exactly zero, and the motion that survives is
 * concentrated into a few frames. Penalizing the first, second and third derivatives together
 * makes the surviving pieces the three things a camera operator actually does — hold still, pan at
 * a constant rate, ease in and out of a pan. That is the grammar of a tripod, a dolly and a crane,
 * and reproducing it is why the output reads as *shot* rather than as *filtered*.
 *
 * The published formulation solves this as a linear program. This solves the same objective by
 * iteratively reweighted least squares: |x| is majorized by x^2 / (2|x_previous|), and repeatedly
 * solving the resulting weighted least-squares system converges on the L1 solution. The system is
 * banded, so each round costs a linear-time solve, and the whole thing runs in milliseconds
 * without shipping an LP solver.
 */

import { addToBanded, createBandedMatrix, solveBanded } from './banded-solver'

export interface SmoothingWeights {
  /** Penalty on velocity — how strongly the result prefers to hold still. */
  first: number
  /** Penalty on acceleration — how strongly it prefers a constant-rate move. */
  second: number
  /** Penalty on jerk — how strongly it prefers an eased start and stop. */
  third: number
}

export interface SmoothingOptions {
  /**
   * How far the smoothed path may sit from the original before the crop window would leave the
   * frame, in pixels. Expressed per frame so a shot can be given room where it needs it.
   */
  budget: Float64Array | number
  weights?: SmoothingWeights
  /** IRLS rounds. */
  iterations?: number
  /**
   * How hard a residual past the budget is pushed back.
   *
   * This is a strong pull, not a wall: at equilibrium the residual settles a little past the
   * budget, by however much the derivative terms are pulling the other way — in practice within a
   * quarter of it. Cranking the penalty up to close that gap backfires, because the weight it puts
   * on a handful of frames dwarfs everything else in the system and the solve loses conditioning
   * long before the gap closes. The hard guarantee lives downstream instead, in the exact crop
   * coverage test, which is geometry rather than optimization and cannot be argued with.
   */
  penalty?: number
  /**
   * Pull toward the original path, applied everywhere. Small but non-zero: within the budget an
   * L1 objective is indifferent to a constant offset, and this picks the offset that keeps the
   * framing the operator chose rather than an arbitrary one.
   */
  anchor?: number
}

/**
 * Grundmann's published weights. The ordering is what carries the intent — jerk is penalized a
 * hundred times harder than acceleration, so the solver will accept a constant-rate pan long
 * before it accepts one that keeps changing rate.
 */
export const DEFAULT_WEIGHTS: SmoothingWeights = { first: 10, second: 1, third: 100 }

const DEFAULT_ITERATIONS = 32
const DEFAULT_PENALTY = 2000
const DEFAULT_ANCHOR = 0.02

/** Floor on an IRLS denominator, in pixels. Also the scale below which motion is "already zero". */
const EPSILON = 1e-3

/** Finite-difference stencils for the first, second and third derivative. */
const STENCILS: readonly number[][] = [
  [-1, 1],
  [1, -2, 1],
  [-1, 3, -3, 1],
]

const BANDWIDTH = 3

/**
 * Smooth one parameter series.
 *
 * `path` is the measured camera path in pixel-equivalent units — see `camera-path` for why
 * rotation and scale are converted into pixels before they get here. Returns the smoothed path in
 * the same units and the same length.
 */
export function smoothPathL1(path: Float64Array, options: SmoothingOptions): Float64Array {
  const size = path.length
  if (size === 0) return new Float64Array(0)
  // Two frames cannot express a derivative worth minimizing; anything the solver did here would be
  // arbitrary, and holding the original path is the honest answer.
  if (size < 4) return new Float64Array(path)

  const weights = options.weights ?? DEFAULT_WEIGHTS
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  const penalty = options.penalty ?? DEFAULT_PENALTY
  const anchor = options.anchor ?? DEFAULT_ANCHOR
  const budget =
    typeof options.budget === 'number'
      ? new Float64Array(size).fill(options.budget)
      : options.budget

  const weightByOrder = [weights.first, weights.second, weights.third]
  let smoothed: Float64Array = new Float64Array(path)

  for (let round = 0; round < iterations; round++) {
    const matrix = createBandedMatrix(size, BANDWIDTH)
    const rhs = new Float64Array(size)

    // Anchor plus the budget penalty. The penalty weight is the one that makes a quadratic step
    // match the gradient of the hinge it stands in for, so the residual is pushed back to the
    // budget rather than all the way to zero.
    for (let i = 0; i < size; i++) {
      const residual = smoothed[i]! - path[i]!
      const magnitude = Math.abs(residual)
      const excess = Math.max(0, magnitude - budget[i]!)
      const weight = anchor + (excess > 0 ? (penalty * excess) / Math.max(magnitude, EPSILON) : 0)
      addToBanded(matrix, i, i, weight)
      rhs[i] = rhs[i]! + weight * path[i]!
    }

    for (let order = 0; order < STENCILS.length; order++) {
      const stencil = STENCILS[order]!
      const orderWeight = weightByOrder[order]!
      if (orderWeight <= 0) continue

      for (let start = 0; start + stencil.length <= size; start++) {
        let derivative = 0
        for (let k = 0; k < stencil.length; k++) {
          derivative += stencil[k]! * smoothed[start + k]!
        }
        // The IRLS surrogate for |derivative|.
        const weight = orderWeight / (2 * Math.max(Math.abs(derivative), EPSILON))
        for (let a = 0; a < stencil.length; a++) {
          for (let b = 0; b <= a; b++) {
            addToBanded(matrix, start + a, start + b, weight * stencil[a]! * stencil[b]!)
          }
        }
      }
    }

    smoothed = solveBanded(matrix, rhs)
  }

  return smoothed
}

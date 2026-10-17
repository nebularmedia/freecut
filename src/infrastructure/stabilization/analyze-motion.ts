/**
 * The per-frame half of the analysis pass.
 *
 * Features are re-detected on every frame rather than tracked across many. Long-lived tracks are
 * cheaper and are the right choice when the goal is to reconstruct a scene, but they accumulate
 * drift, and drift in a stabilizer is indistinguishable from slow camera motion — it becomes a
 * gradual, unwanted glide. Re-detecting makes every measurement independent of the ones before it,
 * so the only error that can accumulate is in the path itself, where the smoother can see it.
 */

import { detectCorners, type CornerDetectionOptions } from './corners'
import { buildPyramid, rgbaToLuma } from './grayscale'
import { estimateMotion, type MotionEstimationOptions } from './motion-estimation'
import { trackFeatures, type TrackOptions } from './klt'
import type { FrameMotion, GrayImage } from './types'
import { IDENTITY_TRANSFORM } from './types'

export interface MotionAnalysisOptions {
  pyramidLevels?: number
  corners?: CornerDetectionOptions
  tracking?: TrackOptions
  estimation?: MotionEstimationOptions
}

/**
 * Four levels covers a displacement of roughly sixteen times the tracking window — around 80
 * pixels at the analysis resolution, which is a violent shake at 30fps and beyond anything a
 * normal handheld shot produces.
 */
const DEFAULT_PYRAMID_LEVELS = 4

export class MotionAnalyzer {
  private previous: GrayImage[] | null = null

  constructor(private readonly options: MotionAnalysisOptions = {}) {}

  /**
   * Feed the next frame and get its motion relative to the previous one. The first frame has no
   * predecessor and reports the identity at full confidence — it is the reference every later
   * frame is measured against, not a measurement itself.
   */
  push(rgba: Uint8ClampedArray, width: number, height: number): FrameMotion {
    const pyramid = buildPyramid(
      rgbaToLuma(rgba, width, height),
      this.options.pyramidLevels ?? DEFAULT_PYRAMID_LEVELS,
    )
    const previous = this.previous
    this.previous = pyramid

    if (!previous) {
      return { transform: IDENTITY_TRANSFORM, confidence: 1, trackedCount: 0, inlierCount: 0 }
    }

    const corners = detectCorners(previous[0]!, this.options.corners)
    if (corners.length === 0) {
      return { transform: IDENTITY_TRANSFORM, confidence: 0, trackedCount: 0, inlierCount: 0 }
    }

    const pairs = trackFeatures(previous, pyramid, corners, this.options.tracking)
    return estimateMotion(pairs, this.options.estimation)
  }
}

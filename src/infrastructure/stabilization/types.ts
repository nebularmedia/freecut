/**
 * Shared vocabulary for the stabilizer.
 *
 * Every stage speaks in *similarity* transforms — uniform scale, rotation, translation. That is a
 * deliberate ceiling. A full homography fits estimation noise as readily as it fits real camera
 * motion, and the low-frequency wobble it bakes into the result is more objectionable than the
 * shake it removed. Handheld motion is overwhelmingly similarity-shaped anyway.
 */

/** A point in image pixels, origin at the top-left corner. */
export interface Point {
  x: number
  y: number
}

/** A single-channel image backed by a flat row-major buffer. */
export interface GrayImage {
  data: Float32Array
  width: number
  height: number
}

/**
 * `p' = scale * R(rotation) * p + t`, with rotation counter-clockwise in radians and the origin at
 * the image's top-left corner.
 */
export interface SimilarityTransform {
  rotation: number
  scale: number
  translateX: number
  translateY: number
}

/** A feature followed from one frame to the next. */
export interface TrackedPair {
  from: Point
  to: Point
}

/**
 * Frame-to-frame motion plus the evidence behind it. `confidence` is the share of tracked features
 * that agreed with the fitted model; a scene cut or a frame of motion blur drops it toward zero,
 * and the path builder treats those frames as "no measurable motion" rather than trusting a fit
 * made from noise.
 */
export interface FrameMotion {
  transform: SimilarityTransform
  confidence: number
  trackedCount: number
  inlierCount: number
}

export const IDENTITY_TRANSFORM: SimilarityTransform = {
  rotation: 0,
  scale: 1,
  translateX: 0,
  translateY: 0,
}

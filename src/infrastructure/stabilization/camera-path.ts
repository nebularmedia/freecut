/**
 * From frame-to-frame motion to a per-frame warp.
 *
 * This is where the pieces meet: accumulate the measured motion into the path the camera actually
 * traveled, ask the smoother for the path it should have traveled, and hand back the difference
 * as the correction to apply to each frame.
 */

import { DEFAULT_WEIGHTS, smoothPathL1, type SmoothingWeights } from './l1-smoothing'
import { maxCoveringFactor, attenuateWarp, smoothAttenuation } from './crop-fit'
import { composeTransforms, invertTransform, recenterTransform } from './transform'
import { IDENTITY_TRANSFORM, type FrameMotion, type SimilarityTransform } from './types'

export interface StabilizationPlanOptions {
  /** Fraction of the frame kept. 0.9 zooms in by ~11% and leaves a 5% border on each side. */
  cropRatio?: number
  weights?: SmoothingWeights
  /** Frames over which a forced concession to the crop is eased in and out. */
  attenuationRadiusFrames?: number
  /** Below this confidence a frame's motion is treated as a scene cut. */
  cutConfidence?: number
  /** Segments shorter than this are left untouched rather than smoothed. */
  minSegmentFrames?: number
}

export interface StabilizationPlan {
  /** One warp per frame, in center-origin pixels at the analysis resolution. */
  warps: SimilarityTransform[]
  /** Zoom the renderer must apply to hide the borders the warps expose. */
  cropRatio: number
  /** Per frame: 1 where the shot was fully stabilized, lower where the crop ran out. */
  attenuation: Float64Array
  /** How many independent shots the clip was split into. */
  segmentCount: number
  /** Frames whose motion could not be measured at all. */
  unmeasuredFrames: number
}

const DEFAULTS: Required<StabilizationPlanOptions> = {
  cropRatio: 0.9,
  weights: DEFAULT_WEIGHTS,
  attenuationRadiusFrames: 8,
  cutConfidence: 0.2,
  minSegmentFrames: 4,
}

/**
 * How the crop margin is shared out between the four things a similarity can do.
 *
 * Translation gets the lion's share because handheld shake is overwhelmingly translational, and
 * the split is deliberately loose rather than a strict partition — four series each at their limit
 * would overrun the margin. The exact per-frame coverage test is what actually guarantees the
 * result; this only has to keep that test from having to intervene very often.
 */
const TRANSLATION_BUDGET_SHARE = 0.7
const ROTATION_BUDGET_SHARE = 0.35
const SCALE_BUDGET_SHARE = 0.35

interface PathSeries {
  translateX: Float64Array
  translateY: Float64Array
  /** Radians and log-scale, both converted to the corner displacement they cause, in pixels. */
  rotationPixels: Float64Array
  scalePixels: Float64Array
}

/**
 * Accumulated camera path, re-expressed around the frame center.
 *
 * Recentring first is what makes the numbers mean anything: with a top-left origin, a one-degree
 * roll of a 1080p frame reports a translation of about 19 pixels that no viewer would call a pan,
 * and the smoother would spend its budget chasing it.
 */
export function accumulatePath(
  motions: readonly FrameMotion[],
  width: number,
  height: number,
  cutConfidence: number,
): { path: SimilarityTransform[]; cuts: number[] } {
  const centerX = width / 2
  const centerY = height / 2
  const path: SimilarityTransform[] = []
  const cuts: number[] = []
  let current: SimilarityTransform = IDENTITY_TRANSFORM

  for (let i = 0; i < motions.length; i++) {
    const motion = motions[i]!
    if (i > 0 && motion.confidence < cutConfidence) {
      // Nothing links this frame to the previous one, so the path before it says nothing about
      // where the camera is now. Start a fresh path rather than carrying a fiction forward.
      cuts.push(i)
      current = IDENTITY_TRANSFORM
    } else if (i > 0) {
      current = composeTransforms(recenterTransform(motion.transform, centerX, centerY), current)
    }
    path.push(current)
  }

  return { path, cuts }
}

function toSeries(path: readonly SimilarityTransform[], cornerRadius: number): PathSeries {
  const size = path.length
  const series: PathSeries = {
    translateX: new Float64Array(size),
    translateY: new Float64Array(size),
    rotationPixels: new Float64Array(size),
    scalePixels: new Float64Array(size),
  }
  for (let i = 0; i < size; i++) {
    const transform = path[i]!
    series.translateX[i] = transform.translateX
    series.translateY[i] = transform.translateY
    // A roll of theta swings a corner by roughly theta * radius, and a zoom of s moves it by
    // log(s) * radius. Converting both into the pixels they displace lets one set of weights and
    // one crop budget govern all four series.
    series.rotationPixels[i] = transform.rotation * cornerRadius
    series.scalePixels[i] = Math.log(transform.scale) * cornerRadius
  }
  return series
}

function fromSeries(series: PathSeries, index: number, cornerRadius: number): SimilarityTransform {
  return {
    translateX: series.translateX[index]!,
    translateY: series.translateY[index]!,
    rotation: series.rotationPixels[index]! / cornerRadius,
    scale: Math.exp(series.scalePixels[index]! / cornerRadius),
  }
}

/** Contiguous runs of frames belonging to one shot. */
function segmentRanges(frameCount: number, cuts: readonly number[]): [number, number][] {
  const boundaries = [0, ...cuts, frameCount]
  const ranges: [number, number][] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!
    const end = boundaries[i + 1]!
    if (end > start) ranges.push([start, end])
  }
  return ranges
}

function smoothSegment(
  source: Float64Array,
  start: number,
  end: number,
  budget: number,
  weights: SmoothingWeights,
  destination: Float64Array,
): void {
  const smoothed = smoothPathL1(source.slice(start, end), { budget, weights })
  destination.set(smoothed, start)
}

/**
 * Plan the stabilization of a clip.
 *
 * `motions` carries one entry per frame; the first frame has no predecessor and its entry is
 * ignored. Each shot between scene cuts is smoothed on its own — a path accumulated across a cut
 * describes no real camera, and smoothing through one would swing both shots around to reconcile
 * a jump that was never motion in the first place.
 */
export function planStabilization(
  motions: readonly FrameMotion[],
  width: number,
  height: number,
  options: StabilizationPlanOptions = {},
): StabilizationPlan {
  const { cropRatio, weights, attenuationRadiusFrames, cutConfidence, minSegmentFrames } = {
    ...DEFAULTS,
    ...options,
  }
  const frameCount = motions.length
  if (frameCount === 0) {
    return {
      warps: [],
      cropRatio,
      attenuation: new Float64Array(0),
      segmentCount: 0,
      unmeasuredFrames: 0,
    }
  }

  const { path, cuts } = accumulatePath(motions, width, height, cutConfidence)
  const cornerRadius = Math.hypot(width, height) / 2
  const measured = toSeries(path, cornerRadius)

  const marginX = (width * (1 - cropRatio)) / 2
  const marginY = (height * (1 - cropRatio)) / 2
  const marginMin = Math.min(marginX, marginY)

  const smoothed: PathSeries = {
    translateX: new Float64Array(measured.translateX),
    translateY: new Float64Array(measured.translateY),
    rotationPixels: new Float64Array(measured.rotationPixels),
    scalePixels: new Float64Array(measured.scalePixels),
  }

  const ranges = segmentRanges(frameCount, cuts)
  for (const [start, end] of ranges) {
    if (end - start < minSegmentFrames) continue
    smoothSegment(
      measured.translateX,
      start,
      end,
      marginX * TRANSLATION_BUDGET_SHARE,
      weights,
      smoothed.translateX,
    )
    smoothSegment(
      measured.translateY,
      start,
      end,
      marginY * TRANSLATION_BUDGET_SHARE,
      weights,
      smoothed.translateY,
    )
    smoothSegment(
      measured.rotationPixels,
      start,
      end,
      marginMin * ROTATION_BUDGET_SHARE,
      weights,
      smoothed.rotationPixels,
    )
    smoothSegment(
      measured.scalePixels,
      start,
      end,
      marginMin * SCALE_BUDGET_SHARE,
      weights,
      smoothed.scalePixels,
    )
  }

  // The correction takes frame i back to where the camera really was, then forward to where it
  // should have been.
  const warps: SimilarityTransform[] = []
  const limits = new Float64Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    const warp = composeTransforms(fromSeries(smoothed, i, cornerRadius), invertTransform(path[i]!))
    warps.push(warp)
    limits[i] = maxCoveringFactor(warp, width, height, cropRatio)
  }

  const attenuation = smoothAttenuation(limits, attenuationRadiusFrames)
  const finalWarps = warps.map((warp, index) =>
    attenuation[index]! >= 1 ? warp : attenuateWarp(warp, attenuation[index]!),
  )

  let unmeasuredFrames = 0
  for (let i = 1; i < frameCount; i++) {
    if (motions[i]!.confidence < cutConfidence) unmeasuredFrames++
  }

  return {
    warps: finalWarps,
    cropRatio,
    attenuation,
    segmentCount: ranges.length,
    unmeasuredFrames,
  }
}

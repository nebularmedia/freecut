// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { accumulatePath, planStabilization } from './camera-path'
import { warpCoversCrop } from './crop-fit'
import { applyTransform, composeTransforms, invertTransform, recenterTransform } from './transform'
import { IDENTITY_TRANSFORM, type FrameMotion, type SimilarityTransform } from './types'

const WIDTH = 960
const HEIGHT = 540
const CENTER_X = WIDTH / 2
const CENTER_Y = HEIGHT / 2

function shake(seed: number): () => number {
  let state = seed | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) / 0x100000000) * 2 - 1
  }
}

/**
 * Turn a sequence of absolute camera poses into the frame-to-frame motions the estimator would
 * have reported, in the top-left origin those measurements come in.
 */
function motionsFromPath(path: readonly SimilarityTransform[]): FrameMotion[] {
  return path.map((pose, index) => {
    if (index === 0) {
      return { transform: IDENTITY_TRANSFORM, confidence: 1, trackedCount: 0, inlierCount: 0 }
    }
    const centered = composeTransforms(pose, invertTransform(path[index - 1]!))
    return {
      transform: recenterTransform(centered, -CENTER_X, -CENTER_Y),
      confidence: 0.95,
      trackedCount: 200,
      inlierCount: 190,
    }
  })
}

/** How far the frame center travels frame to frame, summed over the clip. */
function centerTravel(path: readonly SimilarityTransform[]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const previous = applyTransform(path[i - 1]!, { x: 0, y: 0 })
    const current = applyTransform(path[i]!, { x: 0, y: 0 })
    total += Math.hypot(current.x - previous.x, current.y - previous.y)
  }
  return total
}

/** A slow pan with handheld shake riding on it, in center-origin coordinates. */
function handheldPath(frames: number, seed: number, panPerFrame = 0.8): SimilarityTransform[] {
  const noise = shake(seed)
  return Array.from({ length: frames }, (_, i) => ({
    rotation: noise() * 0.004,
    scale: 1 + noise() * 0.002,
    translateX: i * panPerFrame + noise() * 6,
    translateY: noise() * 5,
  }))
}

describe('accumulatePath', () => {
  it('rebuilds the path from frame-to-frame motions, relative to the first frame', () => {
    const truth = handheldPath(40, 3)
    const { path, cuts } = accumulatePath(motionsFromPath(truth), WIDTH, HEIGHT, 0.2)

    expect(cuts).toHaveLength(0)
    for (let i = 0; i < truth.length; i++) {
      // Frame-to-frame motion carries no absolute reference, so the first frame is the origin the
      // rest are measured against.
      const expected = composeTransforms(truth[i]!, invertTransform(truth[0]!))
      expect(path[i]!.translateX).toBeCloseTo(expected.translateX, 6)
      expect(path[i]!.translateY).toBeCloseTo(expected.translateY, 6)
      expect(path[i]!.rotation).toBeCloseTo(expected.rotation, 8)
      expect(path[i]!.scale).toBeCloseTo(expected.scale, 8)
    }
  })

  it('restarts the path at a scene cut', () => {
    const motions = motionsFromPath(handheldPath(30, 4))
    motions[15] = { transform: IDENTITY_TRANSFORM, confidence: 0, trackedCount: 3, inlierCount: 0 }

    const { path, cuts } = accumulatePath(motions, WIDTH, HEIGHT, 0.2)

    expect(cuts).toEqual([15])
    // The new shot starts from scratch rather than inheriting where the old one had wandered to.
    expect(path[15]!).toEqual(IDENTITY_TRANSFORM)
  })
})

describe('planStabilization', () => {
  it('takes the shake out of a handheld pan', () => {
    const truth = handheldPath(180, 5)
    const plan = planStabilization(motionsFromPath(truth), WIDTH, HEIGHT)

    // The path the virtual camera ends up on is the measured path with the correction applied.
    const stabilized = truth.map((pose, index) => composeTransforms(plan.warps[index]!, pose))

    expect(centerTravel(stabilized)).toBeLessThan(centerTravel(truth) * 0.5)
    // And the pan itself is still there — a stabilizer that also removed the move would be
    // fighting the operator, not helping.
    const start = applyTransform(stabilized[0]!, { x: 0, y: 0 })
    const end = applyTransform(stabilized[stabilized.length - 1]!, { x: 0, y: 0 })
    expect(end.x - start.x).toBeGreaterThan(100)
  })

  it('holds a static shot completely still', () => {
    const noise = shake(9)
    const truth: SimilarityTransform[] = Array.from({ length: 150 }, () => ({
      rotation: noise() * 0.006,
      scale: 1,
      translateX: noise() * 7,
      translateY: noise() * 7,
    }))

    const plan = planStabilization(motionsFromPath(truth), WIDTH, HEIGHT)
    const stabilized = truth.map((pose, index) => composeTransforms(plan.warps[index]!, pose))

    expect(centerTravel(stabilized)).toBeLessThan(centerTravel(truth) * 0.05)
  })

  it('never asks for a pixel the source does not have', () => {
    // Shake far beyond what a 10% crop can absorb, so the attenuation path is exercised.
    const noise = shake(13)
    const truth: SimilarityTransform[] = Array.from({ length: 120 }, (_, i) => ({
      rotation: noise() * 0.05,
      scale: 1 + noise() * 0.01,
      translateX: i * 0.5 + noise() * 60,
      translateY: noise() * 45,
    }))

    const plan = planStabilization(motionsFromPath(truth), WIDTH, HEIGHT)

    for (const warp of plan.warps) {
      expect(warpCoversCrop(warp, WIDTH, HEIGHT, plan.cropRatio)).toBe(true)
    }
    // It had to give ground somewhere, and it should say so.
    expect(Math.min(...Array.from(plan.attenuation))).toBeLessThan(1)
  })

  it('smooths each shot in a cut clip independently', () => {
    const first = handheldPath(60, 21)
    const second = handheldPath(60, 22)
    const motions = [...motionsFromPath(first), ...motionsFromPath(second)]
    motions[60] = { transform: IDENTITY_TRANSFORM, confidence: 0, trackedCount: 2, inlierCount: 0 }

    const plan = planStabilization(motions, WIDTH, HEIGHT)

    expect(plan.segmentCount).toBe(2)
    expect(plan.unmeasuredFrames).toBe(1)

    // The decisive check: the second shot is corrected exactly as it would have been on its own.
    // Anything the first shot did leaks in only if the smoother ran across the cut.
    const standalone = planStabilization(motionsFromPath(second), WIDTH, HEIGHT)
    expect(Math.min(...Array.from(plan.attenuation))).toBe(1)
    for (let i = 0; i < second.length; i++) {
      expect(plan.warps[60 + i]!.translateX).toBeCloseTo(standalone.warps[i]!.translateX, 9)
      expect(plan.warps[60 + i]!.translateY).toBeCloseTo(standalone.warps[i]!.translateY, 9)
      expect(plan.warps[60 + i]!.rotation).toBeCloseTo(standalone.warps[i]!.rotation, 9)
    }
  })

  it('leaves a clip too short to smooth untouched', () => {
    const plan = planStabilization(motionsFromPath(handheldPath(3, 8)), WIDTH, HEIGHT)

    for (const warp of plan.warps) {
      expect(warp.translateX).toBeCloseTo(0, 6)
      expect(warp.translateY).toBeCloseTo(0, 6)
    }
  })

  it('handles a clip with no frames', () => {
    const plan = planStabilization([], WIDTH, HEIGHT)

    expect(plan.warps).toHaveLength(0)
    expect(plan.segmentCount).toBe(0)
  })

  it('gives a tighter crop more room to work with', () => {
    const truth = handheldPath(150, 17, 0)
    const motions = motionsFromPath(truth)

    const tight = planStabilization(motions, WIDTH, HEIGHT, { cropRatio: 0.98 })
    const generous = planStabilization(motions, WIDTH, HEIGHT, { cropRatio: 0.85 })

    const tightResidual = centerTravel(
      truth.map((pose, index) => composeTransforms(tight.warps[index]!, pose)),
    )
    const generousResidual = centerTravel(
      truth.map((pose, index) => composeTransforms(generous.warps[index]!, pose)),
    )

    expect(generousResidual).toBeLessThan(tightResidual)
  })
})

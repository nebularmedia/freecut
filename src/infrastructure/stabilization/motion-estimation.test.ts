// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { estimateMotion, fitSimilarity } from './motion-estimation'
import { applyTransform } from './transform'
import type { SimilarityTransform, TrackedPair } from './types'

const TRUTH: SimilarityTransform = {
  rotation: 0.04,
  scale: 1.02,
  translateX: 7.5,
  translateY: -3.25,
}

function sampler(seed: number): () => number {
  let state = seed | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

function inlierPairs(count: number, transform: SimilarityTransform, seed = 42): TrackedPair[] {
  const random = sampler(seed)
  return Array.from({ length: count }, () => {
    const from = { x: random() * 960, y: random() * 540 }
    return { from, to: applyTransform(transform, from) }
  })
}

describe('fitSimilarity', () => {
  it('recovers a transform exactly from two correspondences', () => {
    const [a, b] = inlierPairs(2, TRUTH)
    const fitted = fitSimilarity([a!, b!])!

    expect(fitted.rotation).toBeCloseTo(TRUTH.rotation, 8)
    expect(fitted.scale).toBeCloseTo(TRUTH.scale, 8)
    expect(fitted.translateX).toBeCloseTo(TRUTH.translateX, 6)
    expect(fitted.translateY).toBeCloseTo(TRUTH.translateY, 6)
  })

  it('returns a pure translation when every feature sits on one spot', () => {
    const from = { x: 100, y: 100 }
    const fitted = fitSimilarity([
      { from, to: { x: 110, y: 90 } },
      { from, to: { x: 110, y: 90 } },
    ])!

    expect(fitted.scale).toBe(1)
    expect(fitted.rotation).toBe(0)
    expect(fitted.translateX).toBeCloseTo(10, 9)
    expect(fitted.translateY).toBeCloseTo(-10, 9)
  })

  it('needs at least two correspondences', () => {
    expect(fitSimilarity([])).toBeNull()
    expect(fitSimilarity(inlierPairs(1, TRUTH))).toBeNull()
  })
})

describe('estimateMotion', () => {
  it('recovers the camera motion from clean correspondences', () => {
    const motion = estimateMotion(inlierPairs(120, TRUTH))

    expect(motion.confidence).toBeGreaterThan(0.95)
    expect(motion.transform.rotation).toBeCloseTo(TRUTH.rotation, 6)
    expect(motion.transform.scale).toBeCloseTo(TRUTH.scale, 6)
    expect(motion.transform.translateX).toBeCloseTo(TRUTH.translateX, 4)
    expect(motion.transform.translateY).toBeCloseTo(TRUTH.translateY, 4)
  })

  it('ignores a large moving subject', () => {
    const random = sampler(9)
    // 40% of the features belong to something crossing the frame on its own path — enough to drag
    // a least-squares fit badly off, and the exact case that makes a stabilizer swing the
    // background around a walking person.
    const subject: SimilarityTransform = {
      rotation: 0,
      scale: 1,
      translateX: -60,
      translateY: 25,
    }
    const pairs = [
      ...inlierPairs(90, TRUTH, 5),
      ...Array.from({ length: 60 }, () => {
        const from = { x: random() * 300, y: random() * 300 }
        return { from, to: applyTransform(subject, from) }
      }),
    ]

    const motion = estimateMotion(pairs)

    expect(motion.transform.translateX).toBeCloseTo(TRUTH.translateX, 3)
    expect(motion.transform.translateY).toBeCloseTo(TRUTH.translateY, 3)
    expect(motion.inlierCount).toBeGreaterThanOrEqual(90)
  })

  it('survives scattered mistracks', () => {
    const random = sampler(21)
    const pairs = [
      ...inlierPairs(100, TRUTH, 13),
      ...Array.from({ length: 30 }, () => ({
        from: { x: random() * 960, y: random() * 540 },
        to: { x: random() * 960, y: random() * 540 },
      })),
    ]

    const motion = estimateMotion(pairs)

    expect(motion.transform.translateX).toBeCloseTo(TRUTH.translateX, 2)
    expect(motion.confidence).toBeGreaterThan(0.6)
  })

  it('reports no confidence when there is nothing to measure', () => {
    const motion = estimateMotion(inlierPairs(4, TRUTH))

    expect(motion.confidence).toBe(0)
    expect(motion.transform.scale).toBe(1)
    expect(motion.transform.translateX).toBe(0)
  })

  it('reports no confidence when the correspondences agree on nothing', () => {
    const random = sampler(77)
    const pairs = Array.from({ length: 60 }, () => ({
      from: { x: random() * 960, y: random() * 540 },
      to: { x: random() * 960, y: random() * 540 },
    }))

    const motion = estimateMotion(pairs)

    expect(motion.confidence).toBeLessThan(0.35)
  })

  it('is deterministic', () => {
    const pairs = inlierPairs(80, TRUTH, 31)
    const first = estimateMotion(pairs)
    const second = estimateMotion(pairs)

    expect(second.transform).toEqual(first.transform)
    expect(second.inlierCount).toBe(first.inlierCount)
  })
})

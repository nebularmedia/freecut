// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { smoothPathL1 } from './l1-smoothing'

/** Deterministic pseudo-random shake, so a regression is a real change and not a reroll. */
function shake(seed: number): () => number {
  let state = seed | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) / 0x100000000) * 2 - 1
  }
}

function totalVariation(series: Float64Array): number {
  let total = 0
  for (let i = 1; i < series.length; i++) total += Math.abs(series[i]! - series[i - 1]!)
  return total
}

describe('smoothPathL1', () => {
  it('holds a static shot still', () => {
    const noise = shake(7)
    const measured = Float64Array.from({ length: 120 }, () => noise() * 6)

    const smoothed = smoothPathL1(measured, { budget: 20 })

    // A camera that never went anywhere should come back as a camera that never went anywhere.
    expect(totalVariation(smoothed)).toBeLessThan(totalVariation(measured) * 0.05)
  })

  it('keeps a real pan while dropping the shake riding on it', () => {
    const noise = shake(11)
    const frames = 150
    const budget = 8
    const truth = Float64Array.from({ length: frames }, (_, i) => i * 1.5)
    const measured = Float64Array.from(truth, (value) => value + noise() * 5)

    const smoothed = smoothPathL1(measured, { budget })

    // The pan is followed end to end rather than flattened into a hold.
    const traveled = smoothed[frames - 1]! - smoothed[0]!
    expect(traveled).toBeGreaterThan((truth[frames - 1]! - truth[0]!) * 0.95)

    // It stays near the budget the crop can afford. Within that margin an L1 path is free to hold
    // still and catch up later, so this is a budget test, not a fidelity one — and the budget is a
    // strong pull rather than a wall, hence the quarter of slack.
    let worstError = 0
    for (let i = 0; i < frames; i++) {
      worstError = Math.max(worstError, Math.abs(smoothed[i]! - measured[i]!))
    }
    expect(worstError).toBeLessThan(budget * 1.25)

    // And it comes back close to the constant-rate move it really was.
    expect(totalVariation(smoothed)).toBeLessThan(totalVariation(truth) * 1.05)
    expect(totalVariation(measured)).toBeGreaterThan(totalVariation(truth) * 2)
  })

  it('respects the crop budget', () => {
    const frames = 100
    // A ramp the smoother would love to flatten into a hold, but cannot afford to.
    const measured = Float64Array.from({ length: frames }, (_, i) => i * 2)
    const budget = 15

    const smoothed = smoothPathL1(measured, { budget })

    for (let i = 0; i < frames; i++) {
      expect(Math.abs(smoothed[i]! - measured[i]!)).toBeLessThan(budget * 1.25)
    }
  })

  it('concentrates the motion it keeps into few frames', () => {
    const noise = shake(3)
    const frames = 160
    // Still, then a pan, then still again.
    const truth = Float64Array.from({ length: frames }, (_, i) =>
      i < 50 ? 0 : i > 110 ? 60 : (i - 50) * 1,
    )
    const measured = Float64Array.from(truth, (value) => value + noise() * 4)

    const smoothed = smoothPathL1(measured, { budget: 18 })

    // L1 on the derivatives means most frames should end up with essentially zero velocity, which
    // is exactly what a least-squares smoother would fail to produce.
    let stillFrames = 0
    for (let i = 1; i < frames; i++) {
      if (Math.abs(smoothed[i]! - smoothed[i - 1]!) < 0.05) stillFrames++
    }
    expect(stillFrames).toBeGreaterThan(frames * 0.5)
  })

  it('returns short sequences untouched', () => {
    const measured = Float64Array.from([3, -1, 4])
    expect(Array.from(smoothPathL1(measured, { budget: 5 }))).toEqual([3, -1, 4])
  })

  it('handles an empty sequence', () => {
    expect(smoothPathL1(new Float64Array(0), { budget: 5 })).toHaveLength(0)
  })
})

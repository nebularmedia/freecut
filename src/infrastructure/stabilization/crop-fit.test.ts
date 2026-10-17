// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  attenuateWarp,
  cropCorners,
  maxCoveringFactor,
  smoothAttenuation,
  warpCoversCrop,
} from './crop-fit'
import { IDENTITY_TRANSFORM, type SimilarityTransform } from './types'

const WIDTH = 960
const HEIGHT = 540
const CROP = 0.9

/** The margin a 0.9 crop leaves on each side. */
const MARGIN_X = (WIDTH * (1 - CROP)) / 2
const MARGIN_Y = (HEIGHT * (1 - CROP)) / 2

function shift(translateX: number, translateY: number): SimilarityTransform {
  return { rotation: 0, scale: 1, translateX, translateY }
}

describe('cropCorners', () => {
  it('insets the frame evenly', () => {
    expect(cropCorners(WIDTH, HEIGHT, CROP)).toEqual([
      { x: MARGIN_X, y: MARGIN_Y },
      { x: WIDTH - MARGIN_X, y: MARGIN_Y },
      { x: WIDTH - MARGIN_X, y: HEIGHT - MARGIN_Y },
      { x: MARGIN_X, y: HEIGHT - MARGIN_Y },
    ])
  })

  it('returns the whole frame when nothing is cropped', () => {
    expect(cropCorners(WIDTH, HEIGHT, 1)).toEqual([
      { x: 0, y: 0 },
      { x: WIDTH, y: 0 },
      { x: WIDTH, y: HEIGHT },
      { x: 0, y: HEIGHT },
    ])
  })
})

describe('warpCoversCrop', () => {
  it('accepts a shift that stays inside the margin', () => {
    expect(warpCoversCrop(shift(MARGIN_X - 1, 0), WIDTH, HEIGHT, CROP)).toBe(true)
    expect(warpCoversCrop(shift(0, -(MARGIN_Y - 1)), WIDTH, HEIGHT, CROP)).toBe(true)
  })

  it('rejects a shift past the margin', () => {
    expect(warpCoversCrop(shift(MARGIN_X + 1, 0), WIDTH, HEIGHT, CROP)).toBe(false)
    expect(warpCoversCrop(shift(0, MARGIN_Y + 1), WIDTH, HEIGHT, CROP)).toBe(false)
  })

  it('leaves no room at all without a crop', () => {
    expect(warpCoversCrop(IDENTITY_TRANSFORM, WIDTH, HEIGHT, 1)).toBe(true)
    expect(warpCoversCrop(shift(0.5, 0), WIDTH, HEIGHT, 1)).toBe(false)
  })

  it('accounts for the corner swing of a rotation', () => {
    // Small enough that the corners stay inside the frame.
    expect(warpCoversCrop({ ...IDENTITY_TRANSFORM, rotation: 0.01 }, WIDTH, HEIGHT, CROP)).toBe(
      true,
    )
    // A roll big enough to swing a corner past the border, despite no translation at all.
    expect(warpCoversCrop({ ...IDENTITY_TRANSFORM, rotation: 0.2 }, WIDTH, HEIGHT, CROP)).toBe(
      false,
    )
  })

  it('rejects a zoom out that exposes the edge', () => {
    expect(warpCoversCrop({ ...IDENTITY_TRANSFORM, scale: 0.8 }, WIDTH, HEIGHT, CROP)).toBe(false)
    expect(warpCoversCrop({ ...IDENTITY_TRANSFORM, scale: 1.2 }, WIDTH, HEIGHT, CROP)).toBe(true)
  })
})

describe('attenuateWarp', () => {
  it('returns the identity at zero', () => {
    const attenuated = attenuateWarp(
      { rotation: 0.3, scale: 1.5, translateX: 40, translateY: -20 },
      0,
    )

    expect(attenuated.rotation).toBeCloseTo(0, 12)
    expect(attenuated.scale).toBeCloseTo(1, 12)
    expect(attenuated.translateX).toBeCloseTo(0, 12)
    expect(attenuated.translateY).toBeCloseTo(0, 12)
  })

  it('returns the warp untouched at one', () => {
    const warp = { rotation: 0.3, scale: 1.5, translateX: 40, translateY: -20 }
    const attenuated = attenuateWarp(warp, 1)

    expect(attenuated.rotation).toBeCloseTo(warp.rotation, 12)
    expect(attenuated.scale).toBeCloseTo(warp.scale, 12)
    expect(attenuated.translateX).toBeCloseTo(warp.translateX, 12)
  })

  it('halves a zoom geometrically, not arithmetically', () => {
    // Half of a 2x zoom has to be sqrt(2); the arithmetic midpoint would lurch.
    expect(attenuateWarp({ ...IDENTITY_TRANSFORM, scale: 2 }, 0.5).scale).toBeCloseTo(
      Math.SQRT2,
      12,
    )
  })
})

describe('maxCoveringFactor', () => {
  it('is one for a warp that already fits', () => {
    expect(maxCoveringFactor(shift(MARGIN_X / 2, 0), WIDTH, HEIGHT, CROP)).toBe(1)
  })

  it('finds the fraction of an oversized shift that fits', () => {
    const factor = maxCoveringFactor(shift(MARGIN_X * 4, 0), WIDTH, HEIGHT, CROP)

    expect(factor).toBeGreaterThan(0.2)
    expect(factor).toBeLessThanOrEqual(0.25)
    expect(warpCoversCrop(attenuateWarp(shift(MARGIN_X * 4, 0), factor), WIDTH, HEIGHT, CROP)).toBe(
      true,
    )
  })

  it('always returns a factor whose warp actually covers the crop', () => {
    const awkward: SimilarityTransform = {
      rotation: 0.18,
      scale: 0.82,
      translateX: 130,
      translateY: -95,
    }
    const factor = maxCoveringFactor(awkward, WIDTH, HEIGHT, CROP)

    expect(warpCoversCrop(attenuateWarp(awkward, factor), WIDTH, HEIGHT, CROP)).toBe(true)
  })
})

describe('smoothAttenuation', () => {
  it('never exceeds a frame own limit', () => {
    const limits = Float64Array.from([1, 1, 1, 0.3, 1, 1, 1, 1, 0.9, 1])
    const smoothed = smoothAttenuation(limits, 3)

    for (let i = 0; i < limits.length; i++) {
      expect(smoothed[i]!).toBeLessThanOrEqual(limits[i]! + 1e-12)
    }
  })

  it('eases a lone dip into its neighbors instead of stepping', () => {
    const limits = new Float64Array(21).fill(1)
    limits[10] = 0.2
    const smoothed = smoothAttenuation(limits, 4)

    // The frames either side give ground too, so the concession arrives gradually...
    expect(smoothed[7]!).toBeLessThan(1)
    expect(smoothed[7]!).toBeGreaterThan(smoothed[9]!)
    // ...and no single step is a jolt.
    for (let i = 1; i < smoothed.length; i++) {
      expect(Math.abs(smoothed[i]! - smoothed[i - 1]!)).toBeLessThan(0.35)
    }
  })

  it('leaves an unconstrained clip alone', () => {
    const limits = new Float64Array(10).fill(1)
    expect(Array.from(smoothAttenuation(limits, 4))).toEqual(Array.from(limits))
  })

  it('passes through when there is nothing to smooth', () => {
    expect(smoothAttenuation(new Float64Array(0), 3)).toHaveLength(0)
    expect(Array.from(smoothAttenuation(Float64Array.from([0.5]), 0))).toEqual([0.5])
  })
})

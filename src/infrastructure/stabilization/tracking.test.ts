// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { detectCorners } from './corners'
import {
  buildPyramid,
  analysisSize,
  downsampleByTwo,
  rgbaToLuma,
  sampleBilinear,
} from './grayscale'
import { trackFeatures } from './klt'
import { estimateMotion } from './motion-estimation'
import { applyTransform, invertTransform } from './transform'
import type { GrayImage, SimilarityTransform } from './types'

const WIDTH = 320
const HEIGHT = 240

/**
 * A value-noise field: a coarse random lattice read back with smooth interpolation.
 *
 * Deliberately not a sine pattern. Sinusoids are periodic, so every window matches every other
 * window one period away, and a tracker would be graded on an image where the right answer is
 * genuinely ambiguous. Value noise gives each neighborhood its own signature, which is what real
 * footage does.
 */
function noiseField(seed: number, cell: number): (x: number, y: number) => number {
  const lattice = new Map<number, number>()
  const valueAt = (ix: number, iy: number): number => {
    const key = ix * 73856093 + iy * 19349663 + seed
    const cached = lattice.get(key)
    if (cached !== undefined) return cached
    let state = (key ^ 0x9e3779b9) | 0 || 1
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    const value = ((state >>> 0) / 0x100000000) * 255
    lattice.set(key, value)
    return value
  }

  return (x, y) => {
    const gx = x / cell
    const gy = y / cell
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    // Smoothstep, so the field has continuous gradients for the tracker to solve against.
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const top = valueAt(x0, y0) * (1 - sx) + valueAt(x0 + 1, y0) * sx
    const bottom = valueAt(x0, y0 + 1) * (1 - sx) + valueAt(x0 + 1, y0 + 1) * sx
    return top * (1 - sy) + bottom * sy
  }
}

/** Two scales of noise, so both the coarse pyramid levels and the fine ones have signal. */
function texture(seed: number): (x: number, y: number) => number {
  const coarse = noiseField(seed, 24)
  const fine = noiseField(seed + 977, 6)
  return (x, y) => coarse(x, y) * 0.7 + fine(x, y) * 0.3
}

/**
 * Render the texture as it would appear after the camera moved by `transform`. Sampling the
 * analytic field at the pre-image of each pixel avoids resampling an already-resampled image,
 * so the test measures the tracker rather than accumulated interpolation blur.
 */
function renderFrame(
  field: (x: number, y: number) => number,
  transform: SimilarityTransform,
): GrayImage {
  const inverse = invertTransform(transform)
  const data = new Float32Array(WIDTH * HEIGHT)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const source = applyTransform(inverse, { x, y })
      data[y * WIDTH + x] = field(source.x, source.y)
    }
  }
  return { data, width: WIDTH, height: HEIGHT }
}

function identityFrame(field: (x: number, y: number) => number): GrayImage {
  return renderFrame(field, { rotation: 0, scale: 1, translateX: 0, translateY: 0 })
}

function recover(truth: SimilarityTransform, seed = 5): ReturnType<typeof estimateMotion> {
  const field = texture(seed)
  const previous = buildPyramid(identityFrame(field), 4)
  const next = buildPyramid(renderFrame(field, truth), 4)
  const corners = detectCorners(previous[0]!)
  const pairs = trackFeatures(previous, next, corners)
  return estimateMotion(pairs)
}

describe('detectCorners', () => {
  it('spreads features across the frame', () => {
    const corners = detectCorners(identityFrame(texture(1)))

    expect(corners.length).toBeGreaterThan(100)

    // Every quadrant should be represented; a detector that piles onto one region would leave the
    // motion estimate unconstrained everywhere else.
    const quadrants = new Set<string>()
    for (const corner of corners) {
      quadrants.add(`${corner.x < WIDTH / 2 ? 'l' : 'r'}${corner.y < HEIGHT / 2 ? 't' : 'b'}`)
    }
    expect(quadrants.size).toBe(4)
  })

  it('honors the spacing requirement', () => {
    const minDistance = 10
    const corners = detectCorners(identityFrame(texture(2)), { minDistance })

    for (let i = 0; i < corners.length; i++) {
      for (let j = i + 1; j < corners.length; j++) {
        expect(
          Math.hypot(corners[i]!.x - corners[j]!.x, corners[i]!.y - corners[j]!.y),
        ).toBeGreaterThanOrEqual(minDistance)
      }
    }
  })

  it('finds nothing in a flat frame', () => {
    const flat: GrayImage = {
      data: new Float32Array(WIDTH * HEIGHT).fill(128),
      width: WIDTH,
      height: HEIGHT,
    }
    expect(detectCorners(flat)).toHaveLength(0)
  })

  it('respects the corner budget', () => {
    expect(detectCorners(identityFrame(texture(3)), { maxCorners: 40 }).length).toBeLessThanOrEqual(
      40,
    )
  })
})

describe('trackFeatures', () => {
  it('recovers a small translation to sub-pixel accuracy', () => {
    const motion = recover({ rotation: 0, scale: 1, translateX: 3.4, translateY: -2.1 })

    expect(motion.confidence).toBeGreaterThan(0.8)
    expect(motion.transform.translateX).toBeCloseTo(3.4, 1)
    expect(motion.transform.translateY).toBeCloseTo(-2.1, 1)
  })

  it('recovers a large translation the pyramid is there to catch', () => {
    // Far beyond the 11-pixel correlation window; only the coarse levels make this solvable.
    const motion = recover({ rotation: 0, scale: 1, translateX: 26, translateY: -18 })

    expect(motion.confidence).toBeGreaterThan(0.6)
    expect(motion.transform.translateX).toBeCloseTo(26, 0)
    expect(motion.transform.translateY).toBeCloseTo(-18, 0)
  })

  it('recovers a roll', () => {
    const truth = { rotation: 0.035, scale: 1, translateX: 0, translateY: 0 }
    const motion = recover(truth)

    expect(motion.confidence).toBeGreaterThan(0.7)
    expect(motion.transform.rotation).toBeCloseTo(truth.rotation, 2)
  })

  it('recovers a zoom', () => {
    const truth = { rotation: 0, scale: 1.04, translateX: 0, translateY: 0 }
    const motion = recover(truth)

    expect(motion.confidence).toBeGreaterThan(0.7)
    expect(motion.transform.scale).toBeCloseTo(truth.scale, 2)
  })

  it('recovers a combined move', () => {
    const truth = { rotation: -0.02, scale: 1.02, translateX: 8.5, translateY: 5.25 }
    const motion = recover(truth)

    expect(motion.confidence).toBeGreaterThan(0.7)
    expect(motion.transform.rotation).toBeCloseTo(truth.rotation, 2)
    expect(motion.transform.scale).toBeCloseTo(truth.scale, 2)
    expect(motion.transform.translateX).toBeCloseTo(truth.translateX, 0)
    expect(motion.transform.translateY).toBeCloseTo(truth.translateY, 0)
  })

  it('reports no confidence across a scene cut', () => {
    // Two unrelated frames: nothing tracks, and pretending otherwise would inject a jolt into the
    // path exactly where the footage changes shot.
    const previous = buildPyramid(identityFrame(texture(11)), 4)
    const next = buildPyramid(identityFrame(texture(4242)), 4)
    const pairs = trackFeatures(previous, next, detectCorners(previous[0]!))

    expect(estimateMotion(pairs).confidence).toBeLessThan(0.3)
  })
})

describe('grayscale helpers', () => {
  it('converts rgba to luma with Rec. 709 weights', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255])
    const luma = rgbaToLuma(rgba, 2, 1)

    expect(luma.data[0]!).toBeCloseTo(0.2126 * 255, 4)
    expect(luma.data[1]!).toBeCloseTo(0.7152 * 255, 4)
  })

  it('halves both dimensions and averages the block', () => {
    const image: GrayImage = { data: Float32Array.from([0, 10, 20, 30]), width: 2, height: 2 }
    const half = downsampleByTwo(image)

    expect(half.width).toBe(1)
    expect(half.height).toBe(1)
    expect(half.data[0]!).toBeCloseTo(15, 6)
  })

  it('stops the pyramid before the levels become meaningless', () => {
    const tiny: GrayImage = { data: new Float32Array(16 * 16), width: 16, height: 16 }
    expect(buildPyramid(tiny, 5)).toHaveLength(1)
  })

  it('clamps samples at the border instead of reading past it', () => {
    const image: GrayImage = { data: Float32Array.from([0, 100, 200, 300]), width: 2, height: 2 }

    expect(sampleBilinear(image, -5, -5)).toBeCloseTo(0, 6)
    expect(sampleBilinear(image, 99, 99)).toBeCloseTo(300, 6)
    expect(sampleBilinear(image, 0.5, 0)).toBeCloseTo(50, 6)
  })
})

describe('analysisSize', () => {
  it('scales a large frame down to the working resolution', () => {
    expect(analysisSize(3840, 2160)).toEqual({ width: 960, height: 540 })
  })

  it('keeps the aspect of a portrait frame', () => {
    expect(analysisSize(1080, 1920)).toEqual({ width: 540, height: 960 })
  })

  it('never upscales a small source', () => {
    expect(analysisSize(640, 360)).toEqual({ width: 640, height: 360 })
  })
})

// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { applyTransform, composeTransforms, invertTransform, recenterTransform } from './transform'
import type { SimilarityTransform } from './types'

const SAMPLE: SimilarityTransform = {
  rotation: 0.31,
  scale: 1.14,
  translateX: -23.5,
  translateY: 8.25,
}

describe('composeTransforms', () => {
  it('applies the second argument first', () => {
    const a: SimilarityTransform = { rotation: 0, scale: 2, translateX: 10, translateY: 0 }
    const b: SimilarityTransform = { rotation: 0, scale: 1, translateX: 5, translateY: 0 }
    const point = { x: 1, y: 0 }

    const composed = applyTransform(composeTransforms(a, b), point)
    const sequential = applyTransform(a, applyTransform(b, point))

    expect(composed.x).toBeCloseTo(sequential.x, 10)
    expect(composed.y).toBeCloseTo(sequential.y, 10)
    expect(composed.x).toBeCloseTo(22, 10)
  })

  it('matches sequential application for a rotating, scaling pair', () => {
    const b: SimilarityTransform = { rotation: -0.2, scale: 0.8, translateX: 3, translateY: -7 }
    const point = { x: 12, y: -40 }

    const composed = applyTransform(composeTransforms(SAMPLE, b), point)
    const sequential = applyTransform(SAMPLE, applyTransform(b, point))

    expect(composed.x).toBeCloseTo(sequential.x, 10)
    expect(composed.y).toBeCloseTo(sequential.y, 10)
  })
})

describe('invertTransform', () => {
  it('round trips a point', () => {
    const point = { x: 143.5, y: -62.25 }
    const back = applyTransform(invertTransform(SAMPLE), applyTransform(SAMPLE, point))

    expect(back.x).toBeCloseTo(point.x, 10)
    expect(back.y).toBeCloseTo(point.y, 10)
  })

  it('composes with its source to the identity', () => {
    const identity = composeTransforms(SAMPLE, invertTransform(SAMPLE))

    expect(identity.rotation).toBeCloseTo(0, 10)
    expect(identity.scale).toBeCloseTo(1, 10)
    expect(identity.translateX).toBeCloseTo(0, 10)
    expect(identity.translateY).toBeCloseTo(0, 10)
  })
})

describe('recenterTransform', () => {
  it('describes the same mapping in center-origin coordinates', () => {
    const originX = 480
    const originY = 270
    const centered = recenterTransform(SAMPLE, originX, originY)
    const point = { x: 100, y: 200 }

    const viaOriginal = applyTransform(SAMPLE, point)
    const viaCenterd = applyTransform(centered, { x: point.x - originX, y: point.y - originY })

    expect(viaCenterd.x + originX).toBeCloseTo(viaOriginal.x, 10)
    expect(viaCenterd.y + originY).toBeCloseTo(viaOriginal.y, 10)
  })

  it('leaves a pure roll with no translation about the center', () => {
    const width = 1920
    const height = 1080
    const roll = 0.05
    const cos = Math.cos(roll)
    const sin = Math.sin(roll)
    // The same roll expressed about the top-left corner carries a large translation.
    const aboutCorner: SimilarityTransform = {
      rotation: roll,
      scale: 1,
      translateX: width / 2 - (cos * (width / 2) - sin * (height / 2)),
      translateY: height / 2 - (sin * (width / 2) + cos * (height / 2)),
    }

    const centered = recenterTransform(aboutCorner, width / 2, height / 2)

    expect(centered.translateX).toBeCloseTo(0, 8)
    expect(centered.translateY).toBeCloseTo(0, 8)
    expect(centered.rotation).toBeCloseTo(roll, 10)
  })
})

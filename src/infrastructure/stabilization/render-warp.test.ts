// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { warpToCanvasMatrix } from './render-warp'
import { IDENTITY_TRANSFORM } from './types'

const WIDTH = 1920
const HEIGHT = 1080

/** Apply a canvas matrix the way the 2D context would. */
function map(
  matrix: ReturnType<typeof warpToCanvasMatrix>,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  }
}

describe('warpToCanvasMatrix', () => {
  it('is the identity when nothing is corrected and nothing is cropped', () => {
    const matrix = warpToCanvasMatrix(IDENTITY_TRANSFORM, 1, WIDTH, HEIGHT, 1)

    expect(matrix.a).toBeCloseTo(1, 12)
    expect(matrix.b).toBeCloseTo(0, 12)
    expect(matrix.c).toBeCloseTo(0, 12)
    expect(matrix.d).toBeCloseTo(1, 12)
    expect(matrix.e).toBeCloseTo(0, 10)
    expect(matrix.f).toBeCloseTo(0, 10)
  })

  it('zooms about the frame center', () => {
    const matrix = warpToCanvasMatrix(IDENTITY_TRANSFORM, 0.9, WIDTH, HEIGHT, 1)
    const center = map(matrix, WIDTH / 2, HEIGHT / 2)

    expect(center.x).toBeCloseTo(WIDTH / 2, 8)
    expect(center.y).toBeCloseTo(HEIGHT / 2, 8)
    // A 0.9 crop has to be enlarged by 1/0.9 to fill the output.
    const corner = map(matrix, 0, 0)
    expect(corner.x).toBeCloseTo((WIDTH / 2) * (1 - 1 / 0.9), 8)
  })

  it('rescales translation from the analysis resolution to the render resolution', () => {
    const warp = { ...IDENTITY_TRANSFORM, translateX: 10, translateY: -5 }
    // Analysis ran at 960 wide, the render is 1920 wide.
    const matrix = warpToCanvasMatrix(warp, 1, WIDTH, HEIGHT, 2)
    const center = map(matrix, WIDTH / 2, HEIGHT / 2)

    expect(center.x).toBeCloseTo(WIDTH / 2 + 20, 8)
    expect(center.y).toBeCloseTo(HEIGHT / 2 - 10, 8)
  })

  it('rotates about the frame center, not the corner', () => {
    const warp = { ...IDENTITY_TRANSFORM, rotation: Math.PI / 2 }
    const matrix = warpToCanvasMatrix(warp, 1, WIDTH, HEIGHT, 1)
    const center = map(matrix, WIDTH / 2, HEIGHT / 2)

    expect(center.x).toBeCloseTo(WIDTH / 2, 8)
    expect(center.y).toBeCloseTo(HEIGHT / 2, 8)

    // A quarter turn sends a point to the right of center to a point below it.
    const moved = map(matrix, WIDTH / 2 + 100, HEIGHT / 2)
    expect(moved.x).toBeCloseTo(WIDTH / 2, 6)
    expect(moved.y).toBeCloseTo(HEIGHT / 2 + 100, 6)
  })

  it('combines scale, rotation, translation and crop consistently', () => {
    const warp = { rotation: 0.2, scale: 1.05, translateX: 12, translateY: -8 }
    const cropRatio = 0.9
    const pixelScale = 2
    const matrix = warpToCanvasMatrix(warp, cropRatio, WIDTH, HEIGHT, pixelScale)

    // Work the same mapping by hand: recenter, warp, zoom, return to a top-left origin.
    const point = { x: 400, y: 700 }
    const localX = point.x - WIDTH / 2
    const localY = point.y - HEIGHT / 2
    const cos = Math.cos(warp.rotation) * warp.scale
    const sin = Math.sin(warp.rotation) * warp.scale
    const warpedX = cos * localX - sin * localY + warp.translateX * pixelScale
    const warpedY = sin * localX + cos * localY + warp.translateY * pixelScale
    const expected = {
      x: warpedX / cropRatio + WIDTH / 2,
      y: warpedY / cropRatio + HEIGHT / 2,
    }

    const actual = map(matrix, point.x, point.y)
    expect(actual.x).toBeCloseTo(expected.x, 8)
    expect(actual.y).toBeCloseTo(expected.y, 8)
  })
})

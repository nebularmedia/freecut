// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { addToBanded, createBandedMatrix, solveBanded } from './banded-solver'

/** Reference multiply against the dense form of the same matrix. */
function multiply(dense: number[][], x: Float64Array): Float64Array {
  const result = new Float64Array(x.length)
  for (let i = 0; i < dense.length; i++) {
    let sum = 0
    for (let j = 0; j < x.length; j++) sum += dense[i]![j]! * x[j]!
    result[i] = sum
  }
  return result
}

describe('solveBanded', () => {
  it('solves a tridiagonal system', () => {
    const size = 5
    const matrix = createBandedMatrix(size, 1)
    const dense = Array.from({ length: size }, () => new Array<number>(size).fill(0))
    for (let i = 0; i < size; i++) {
      addToBanded(matrix, i, i, 4)
      dense[i]![i] = 4
      if (i + 1 < size) {
        addToBanded(matrix, i + 1, i, -1)
        dense[i]![i + 1] = -1
        dense[i + 1]![i] = -1
      }
    }

    const expected = Float64Array.from([1, -2, 3, -4, 5])
    const solution = solveBanded(matrix, multiply(dense, expected))

    for (let i = 0; i < size; i++) expect(solution[i]!).toBeCloseTo(expected[i]!, 9)
  })

  it('solves a system at full bandwidth', () => {
    const size = 12
    const bandwidth = 3
    const matrix = createBandedMatrix(size, bandwidth)
    const dense = Array.from({ length: size }, () => new Array<number>(size).fill(0))

    for (let i = 0; i < size; i++) {
      for (let offset = 0; offset <= bandwidth; offset++) {
        const j = i - offset
        if (j < 0) continue
        // Diagonally dominant by construction, so the matrix is positive definite.
        const value = offset === 0 ? 10 : -1 / (offset + 1)
        addToBanded(matrix, i, j, value)
        dense[i]![j] = value
        dense[j]![i] = value
      }
    }

    const expected = Float64Array.from(Array.from({ length: size }, (_, i) => Math.sin(i) * 3))
    const solution = solveBanded(matrix, multiply(dense, expected))

    for (let i = 0; i < size; i++) expect(solution[i]!).toBeCloseTo(expected[i]!, 8)
  })

  it('accepts writes above the diagonal by mirroring them', () => {
    const matrix = createBandedMatrix(2, 1)
    addToBanded(matrix, 0, 0, 2)
    addToBanded(matrix, 1, 1, 2)
    addToBanded(matrix, 0, 1, 1)

    const solution = solveBanded(matrix, Float64Array.from([3, 3]))

    expect(solution[0]!).toBeCloseTo(1, 9)
    expect(solution[1]!).toBeCloseTo(1, 9)
  })

  it('rejects a write outside the bandwidth', () => {
    const matrix = createBandedMatrix(6, 1)
    expect(() => addToBanded(matrix, 4, 1, 1)).toThrow(/bandwidth/)
  })

  it('rejects a system that is not positive definite', () => {
    const matrix = createBandedMatrix(2, 1)
    addToBanded(matrix, 0, 0, -1)
    addToBanded(matrix, 1, 1, 1)

    expect(() => solveBanded(matrix, Float64Array.from([1, 1]))).toThrow(/positive definite/)
  })
})

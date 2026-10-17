/**
 * Cholesky solve for a symmetric positive-definite banded system.
 *
 * The smoother's normal equations couple each frame only to the three frames either side of it, so
 * the matrix is banded and almost entirely zero. A dense factorisation would be O(n^3) — minutes
 * for a one-minute clip — while the banded one is O(n * bandwidth^2), which is linear in the number
 * of frames and finishes in single-digit milliseconds.
 *
 * Storage is lower-band: `matrix[i * (bandwidth + 1) + k]` holds `A(i, i - k)`. Entries whose
 * column index would fall below zero are simply never read.
 */

export interface BandedMatrix {
  /** Lower-band coefficients, `size * (bandwidth + 1)` long. */
  values: Float64Array
  size: number
  bandwidth: number
}

export function createBandedMatrix(size: number, bandwidth: number): BandedMatrix {
  return { values: new Float64Array(size * (bandwidth + 1)), size, bandwidth }
}

/**
 * Accumulate into `A(row, column)`. Writes above the diagonal are ignored because the caller is
 * building a symmetric matrix and the lower triangle already carries the value.
 */
export function addToBanded(
  matrix: BandedMatrix,
  row: number,
  column: number,
  value: number,
): void {
  if (column > row) {
    addToBanded(matrix, column, row, value)
    return
  }
  const offset = row - column
  if (offset > matrix.bandwidth) {
    throw new Error(
      `Banded write at (${row}, ${column}) falls outside bandwidth ${matrix.bandwidth}`,
    )
  }
  matrix.values[row * (matrix.bandwidth + 1) + offset]! += value
}

/**
 * Solve `A x = rhs` in place-free fashion, returning `x`.
 *
 * Throws on a non-positive pivot rather than nudging it: every system this module builds carries a
 * positive diagonal anchor by construction, so a non-positive pivot means the caller assembled
 * something other than what it intended, and silently repairing it would hide that behind a
 * plausible-looking but wrong camera path.
 */
export function solveBanded(matrix: BandedMatrix, rhs: Float64Array): Float64Array {
  const { size, bandwidth } = matrix
  const stride = bandwidth + 1
  const lower = new Float64Array(matrix.values)

  for (let i = 0; i < size; i++) {
    const firstColumn = Math.max(0, i - bandwidth)
    for (let j = firstColumn; j <= i; j++) {
      let sum = lower[i * stride + (i - j)]!
      const from = Math.max(firstColumn, j - bandwidth)
      for (let k = from; k < j; k++) {
        sum -= lower[i * stride + (i - k)]! * lower[j * stride + (j - k)]!
      }
      if (i === j) {
        if (!(sum > 0)) {
          throw new Error(`Banded system is not positive definite at row ${i}`)
        }
        lower[i * stride] = Math.sqrt(sum)
      } else {
        lower[i * stride + (i - j)] = sum / lower[j * stride]!
      }
    }
  }

  // Forward substitution, L y = rhs.
  const y = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    let sum = rhs[i]!
    for (let k = Math.max(0, i - bandwidth); k < i; k++) {
      sum -= lower[i * stride + (i - k)]! * y[k]!
    }
    y[i] = sum / lower[i * stride]!
  }

  // Back substitution, L^T x = y.
  const x = new Float64Array(size)
  for (let i = size - 1; i >= 0; i--) {
    let sum = y[i]!
    for (let k = i + 1; k < Math.min(size, i + bandwidth + 1); k++) {
      sum -= lower[k * stride + (k - i)]! * x[k]!
    }
    x[i] = sum / lower[i * stride]!
  }

  return x
}

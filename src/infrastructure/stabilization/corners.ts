/**
 * Shi-Tomasi corner detection with spatial bucketing.
 *
 * The score is the smaller eigenvalue of the windowed structure tensor, which answers the only
 * question the tracker cares about: does this window constrain motion in *both* directions? An
 * edge scores high on gradient energy and still slides freely along itself — the aperture problem —
 * so gradient magnitude alone would hand the tracker features that drift.
 *
 * Bucketing matters as much as the score. Contrast is never spread evenly across a frame, and a
 * plain global top-N piles every feature onto the one high-contrast object, which is very often the
 * moving subject. Fitting camera motion to those points stabilizes the subject and swings the
 * background around it. Forcing features into every cell of a grid keeps the static surroundings
 * represented, and RANSAC can then reject the subject as the outlier it is.
 */

import type { GrayImage, Point } from './types'

export interface CornerDetectionOptions {
  /** Half-width of the structure-tensor window, in pixels. */
  windowRadius?: number
  /** Upper bound on returned corners. */
  maxCorners?: number
  /** Score floor as a fraction of the frame's best score. */
  qualityLevel?: number
  /** Minimum spacing between accepted corners, in pixels. */
  minDistance?: number
  /** Grid columns/rows used to force spatial spread. */
  gridColumns?: number
  gridRows?: number
}

const DEFAULTS: Required<CornerDetectionOptions> = {
  windowRadius: 3,
  maxCorners: 600,
  qualityLevel: 0.01,
  minDistance: 12,
  gridColumns: 8,
  gridRows: 8,
}

/**
 * Summed-area table over `values`, one row and column larger than the image so a window sum is
 * four lookups regardless of the window size. Float64 because a 960x540 frame of squared gradients
 * accumulates past what float32 can hold without visibly quantising the corner scores.
 */
function integralImage(values: Float32Array, width: number, height: number): Float64Array {
  const stride = width + 1
  const sums = new Float64Array(stride * (height + 1))
  for (let y = 0; y < height; y++) {
    let rowSum = 0
    for (let x = 0; x < width; x++) {
      rowSum += values[y * width + x]!
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1]! + rowSum
    }
  }
  return sums
}

function windowSum(
  sums: Float64Array,
  stride: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  return (
    sums[(y1 + 1) * stride + x1 + 1]! -
    sums[y0 * stride + x1 + 1]! -
    sums[(y1 + 1) * stride + x0]! +
    sums[y0 * stride + x0]!
  )
}

/**
 * Smaller eigenvalue of the windowed structure tensor at every pixel, zero in the border band where
 * a full window does not fit.
 */
function cornerScoreMap(image: GrayImage, windowRadius: number): Float32Array {
  const { data, width, height } = image
  const ixx = new Float32Array(width * height)
  const ixy = new Float32Array(width * height)
  const iyy = new Float32Array(width * height)

  // Central differences, skipping the one-pixel border where they are undefined.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x
      const dx = (data[index + 1]! - data[index - 1]!) * 0.5
      const dy = (data[index + width]! - data[index - width]!) * 0.5
      ixx[index] = dx * dx
      ixy[index] = dx * dy
      iyy[index] = dy * dy
    }
  }

  const stride = width + 1
  const sumXx = integralImage(ixx, width, height)
  const sumXy = integralImage(ixy, width, height)
  const sumYy = integralImage(iyy, width, height)

  const scores = new Float32Array(width * height)
  const margin = windowRadius + 1
  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      const x0 = x - windowRadius
      const y0 = y - windowRadius
      const x1 = x + windowRadius
      const y1 = y + windowRadius
      const a = windowSum(sumXx, stride, x0, y0, x1, y1)
      const b = windowSum(sumXy, stride, x0, y0, x1, y1)
      const c = windowSum(sumYy, stride, x0, y0, x1, y1)
      // Closed-form smaller eigenvalue of [[a, b], [b, c]].
      const half = (a + c) * 0.5
      const offset = Math.sqrt(Math.max(0, (a - c) * (a - c) * 0.25 + b * b))
      scores[y * width + x] = half - offset
    }
  }
  return scores
}

interface Candidate {
  x: number
  y: number
  score: number
  cell: number
}

/**
 * Corners ordered strongest first, spread across the frame and spaced at least `minDistance` apart.
 *
 * Selection runs in two rounds. The first walks the global ranking and fills each grid cell up to
 * its quota, so no region can monopolise the budget. The second spends whatever budget is left on
 * the best remaining candidates anywhere, which lets a genuinely detailed region contribute more
 * than its share once every other region has had its turn.
 */
export function detectCorners(image: GrayImage, options: CornerDetectionOptions = {}): Point[] {
  const { windowRadius, maxCorners, qualityLevel, minDistance, gridColumns, gridRows } = {
    ...DEFAULTS,
    ...options,
  }
  const { width, height } = image
  const scores = cornerScoreMap(image, windowRadius)

  let best = 0
  for (let i = 0; i < scores.length; i++) {
    if (scores[i]! > best) best = scores[i]!
  }
  if (best <= 0) return []
  const threshold = best * qualityLevel

  const cellWidth = width / gridColumns
  const cellHeight = height / gridRows
  const candidates: Candidate[] = []
  const margin = windowRadius + 1

  // 3x3 non-maximum suppression, so a single corner does not enter the ranking a dozen times.
  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      const score = scores[y * width + x]!
      if (score < threshold) continue
      if (
        score < scores[y * width + x - 1]! ||
        score < scores[y * width + x + 1]! ||
        score < scores[(y - 1) * width + x]! ||
        score < scores[(y + 1) * width + x]! ||
        score < scores[(y - 1) * width + x - 1]! ||
        score < scores[(y - 1) * width + x + 1]! ||
        score < scores[(y + 1) * width + x - 1]! ||
        score < scores[(y + 1) * width + x + 1]!
      ) {
        continue
      }
      const column = Math.min(gridColumns - 1, Math.floor(x / cellWidth))
      const row = Math.min(gridRows - 1, Math.floor(y / cellHeight))
      candidates.push({ x, y, score, cell: row * gridColumns + column })
    }
  }

  candidates.sort((a, b) => b.score - a.score)

  // Occupancy grid at `minDistance` resolution turns the spacing test into a lookup over the nine
  // neighboring buckets instead of a scan across every corner accepted so far.
  const spacing = Math.max(1, minDistance)
  const occupancyColumns = Math.ceil(width / spacing)
  const occupancyRows = Math.ceil(height / spacing)
  const occupancy: Point[][] = Array.from(
    { length: occupancyColumns * occupancyRows },
    () => [] as Point[],
  )
  const minDistanceSquared = minDistance * minDistance

  const isTooClose = (x: number, y: number): boolean => {
    const column = Math.floor(x / spacing)
    const row = Math.floor(y / spacing)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = column + dx
        const ny = row + dy
        if (nx < 0 || ny < 0 || nx >= occupancyColumns || ny >= occupancyRows) continue
        for (const point of occupancy[ny * occupancyColumns + nx]!) {
          const ddx = point.x - x
          const ddy = point.y - y
          if (ddx * ddx + ddy * ddy < minDistanceSquared) return true
        }
      }
    }
    return false
  }

  const accepted: Point[] = []
  const perCell = Math.max(1, Math.ceil(maxCorners / (gridColumns * gridRows)))
  const cellCounts = new Int32Array(gridColumns * gridRows)
  const taken = new Uint8Array(candidates.length)

  const accept = (candidate: Candidate, index: number): void => {
    const point = { x: candidate.x, y: candidate.y }
    accepted.push(point)
    occupancy[
      Math.floor(candidate.y / spacing) * occupancyColumns + Math.floor(candidate.x / spacing)
    ]!.push(point)
    cellCounts[candidate.cell] = cellCounts[candidate.cell]! + 1
    taken[index] = 1
  }

  for (let i = 0; i < candidates.length && accepted.length < maxCorners; i++) {
    const candidate = candidates[i]!
    if (cellCounts[candidate.cell]! >= perCell) continue
    if (isTooClose(candidate.x, candidate.y)) continue
    accept(candidate, i)
  }

  for (let i = 0; i < candidates.length && accepted.length < maxCorners; i++) {
    if (taken[i] === 1) continue
    const candidate = candidates[i]!
    if (isTooClose(candidate.x, candidate.y)) continue
    accept(candidate, i)
  }

  return accepted
}

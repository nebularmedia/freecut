/**
 * Stabilization renders a steadied copy of a video: same duration, same frame rate, same
 * resolution, with each frame warped onto a smoothed camera path and zoomed in enough to hide the
 * borders that warping exposes. The result is imported as an ordinary media item, exactly like the
 * upscale and frame-interpolation outputs — not a proxy, and a first-class export source.
 *
 * Be honest about the trade: stabilization costs framing. The output is cropped, and on a shot
 * that moves more than the crop can absorb it will keep some of the original motion rather than
 * show an empty border. Both facts are reported back in the result so the UI can tell the user
 * what actually happened instead of implying a perfect job.
 */

/**
 * Progress phases. Declared here rather than in the worker so app code can name them without
 * importing a module whose top-level installs an `onmessage` handler.
 *
 * There are two working phases because the render genuinely cannot start until the analysis has
 * finished: deciding where frame 1 should sit requires knowing where the camera goes by frame 400.
 * A stabilizer that streamed in one pass would be a smoothing filter with a lag, which is the
 * cheap version of this feature and looks like it.
 */
export type StabilizeStage = 'preparing' | 'analyzing' | 'rendering'

/** Scratch space for the render; the file is imported and then deleted. */
export const STABILIZE_TMP_DIR = 'stabilize-tmp'

/** Tag applied to generated items so their provenance is visible in the library. */
export const STABILIZED_MEDIA_TAG = 'stabilized'

/**
 * Strength is expressed as framing given up, because that is the real choice being made. More
 * border means more room for the correction to move within, and a steadier result; there is no
 * setting that steadies more for free.
 */
export const STABILIZE_STRENGTHS = ['gentle', 'standard', 'strong'] as const

export type StabilizeStrength = (typeof STABILIZE_STRENGTHS)[number]

/** Fraction of the frame kept, per strength. The reciprocal is the zoom the viewer sees. */
export const STRENGTH_CROP_RATIO: Record<StabilizeStrength, number> = {
  gentle: 0.95,
  standard: 0.9,
  strong: 0.85,
}

/**
 * 0.9 zooms in by about 11% and leaves a 5% border on each side — conservative enough that the
 * zoom is not obvious, and roughly where the consumer editors sit for their default.
 */
export const DEFAULT_CROP_RATIO = STRENGTH_CROP_RATIO.standard

export function stabilizeTmpPath(jobId: string): string {
  return `${STABILIZE_TMP_DIR}/${jobId}.mp4`
}

export interface StabilizeResult {
  width: number
  height: number
  fps: number
  codec: string
  frameCount: number
  /** Fraction of the frame kept; the reciprocal is the zoom the viewer sees. */
  cropRatio: number
  /**
   * Lowest correction strength the crop forced anywhere in the clip, from 1 (nothing was given
   * back) down to 0. Well under 1 means the shot out-moved its crop budget.
   */
  attenuationFloor: number
  /** Independent shots found between scene cuts. */
  segmentCount: number
  /** Frames whose motion could not be measured — blur, darkness, or a cut. */
  unmeasuredFrames: number
}

/** `beach.mp4` becomes `beach (stabilized).mp4`. */
export function stabilizedFileName(sourceFileName: string): string {
  const dot = sourceFileName.lastIndexOf('.')
  const base = dot > 0 ? sourceFileName.slice(0, dot) : sourceFileName
  return `${base} (stabilized).mp4`
}

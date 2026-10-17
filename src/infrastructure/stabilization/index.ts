/**
 * Video stabilization: measure the camera's real path, decide the path it should have taken, and
 * warp each frame between the two.
 *
 * The stages are separately usable and separately testable — tracking knows nothing about
 * smoothing, and smoothing knows nothing about canvases — but the ordinary route through them is
 * `MotionAnalyzer` over the frames, then `planStabilization`, then `warpToCanvasMatrix` per frame.
 */

export { MotionAnalyzer, type MotionAnalysisOptions } from './analyze-motion'
export {
  planStabilization,
  type StabilizationPlan,
  type StabilizationPlanOptions,
} from './camera-path'
export { analysisSize } from './grayscale'
export { warpToCanvasMatrix } from './render-warp'
export type { FrameMotion } from './types'

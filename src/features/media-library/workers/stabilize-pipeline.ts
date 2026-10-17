/**
 * The stabilization render itself, with nothing tying it to a worker.
 *
 * Two passes over the source. The first measures how the camera moved; the second warps every
 * frame onto the smoothed path that measurement implies. Two passes rather than one, and that is
 * not an implementation shortcut: where frame 1 belongs depends on where the camera has got to by
 * frame 400, and a hold can only be recognized as a hold once you can see it end. Deciding frame
 * by frame, with only the past to go on, is a low-pass filter with lag — the cheap version, and it
 * shows. The cost of doing it properly is decoding the source twice.
 *
 * Extracted from the worker so the headless harness can run the identical pipeline. The two differ
 * only in where the bytes land and how progress and cancellation are reported, so those are the
 * parameters; everything that decides how the picture looks is shared, and there is no second
 * implementation to drift.
 *
 * This cannot use mediabunny's `Conversion` API — that is a straight transcode with no hook to
 * replace frames.
 */

import { ensureProResDecoderRegistered } from '@/infrastructure/browser/register-prores-decoder'
import {
  analysisSize,
  MotionAnalyzer,
  planStabilization,
  warpToCanvasMatrix,
  type FrameMotion,
  type StabilizationPlan,
} from '@/infrastructure/stabilization'
import { RenderProgress } from '@/shared/utils/render-progress'
import {
  DEFAULT_CROP_RATIO,
  type StabilizeResult,
  type StabilizeStage,
} from '../stabilize-constants'
import {
  createMp4Encoder,
  createRenderCanvas,
  EncodeQueue,
  medianFps,
  openVideoSource,
  setupAudioCopy,
  type Mediabunny,
  type RenderDestination,
} from './render-support'

export interface StabilizeSourceRange {
  startSeconds: number
  endSeconds: number
}

export interface StabilizePipelineRequest {
  source: Blob
  /** Only a hint, for the ETA before the first frame decodes. The true rate is measured. */
  sourceFps: number
  /** Fraction of the frame kept. Lower steadies more and shows less. */
  cropRatio?: number
  /**
   * Source span to render, in seconds. Omit for the whole file.
   *
   * A timeline clip is a window onto its source, and stabilizing the window is not the same job as
   * stabilizing the file: the camera path is accumulated and smoothed over exactly the frames that
   * play, so a hold at the start of the clip is recognized as a hold rather than as the middle of
   * a move that began before the cut.
   */
  range?: StabilizeSourceRange
  /** Where the encoded MP4 is written. */
  destination: RenderDestination
  onProgress?: (stage: StabilizeStage, progress: number, etaSeconds: number | null) => void
  /** Called between frames; throw from it to abort the render. */
  throwIfCancelled?: () => void
}

export interface StabilizePipelineOutcome {
  result: StabilizeResult
  /** The encoded bytes, for a buffer destination. Null when the render streamed elsewhere. */
  buffer: ArrayBuffer | null
}

interface SourceGeometry {
  width: number
  height: number
  totalSeconds: number
}

/** What the render pass alone can report; the plan supplies the rest of `StabilizeResult`. */
type RenderOutcome = Pick<StabilizeResult, 'width' | 'height' | 'fps' | 'codec' | 'frameCount'> & {
  buffer: ArrayBuffer | null
}

interface AnalysisOutcome {
  motions: FrameMotion[]
  geometry: SourceGeometry
  analysis: { width: number; height: number }
}

const noop = () => {}

/**
 * Pass one: measure the camera.
 *
 * Frames are decoded straight into a reduced-resolution canvas. Camera motion is a global,
 * low-frequency signal — measuring it on a 4K frame costs sixteen times as much as measuring it on
 * a 960px one and moves the answer by a fraction of a pixel.
 */
async function analyzeMotion(
  mb: Mediabunny,
  request: StabilizePipelineRequest,
): Promise<AnalysisOutcome> {
  const { sourceFps, range } = request
  const throwIfCancelled = request.throwIfCancelled ?? noop
  const onProgress = request.onProgress ?? noop
  const { input, sink, totalSeconds, width, height } = await openVideoSource(mb, request.source)
  const analysis = analysisSize(width, height)
  const canvas = createRenderCanvas(analysis.width, analysis.height)
  const analyzer = new MotionAnalyzer()
  const motions: FrameMotion[] = []
  const renderedSeconds = range ? Math.max(range.endSeconds - range.startSeconds, 0) : totalSeconds
  const progress = new RenderProgress(renderedSeconds, sourceFps)
  let previousTimestamp: number | null = null

  try {
    for await (const sample of sink.samples(range?.startSeconds, range?.endSeconds)) {
      throwIfCancelled()

      const timestamp = sample.timestamp
      try {
        sample.draw(canvas.ctx, 0, 0, analysis.width, analysis.height)
      } finally {
        sample.close()
      }
      const frame = canvas.ctx.getImageData(0, 0, analysis.width, analysis.height)
      motions.push(analyzer.push(frame.data, analysis.width, analysis.height))

      const gap = previousTimestamp === null ? null : Math.max(timestamp - previousTimestamp, 1e-6)
      previousTimestamp = timestamp
      progress.tick(performance.now(), gap)
      onProgress('analyzing', progress.fraction, progress.etaSeconds)
    }
  } finally {
    input.dispose()
    // Release the analysis canvas; the render pass allocates its own at full size.
    canvas.canvas.width = 1
    canvas.canvas.height = 1
  }

  if (motions.length === 0) throw new Error('Source produced no decodable video frames')
  return { motions, geometry: { width, height, totalSeconds: renderedSeconds }, analysis }
}

/**
 * Pass two: warp and encode.
 *
 * The frame is drawn through the planned transform rather than copied and then transformed, so
 * there is exactly one resampling step between source pixels and output pixels.
 */
async function renderStabilized(
  mb: Mediabunny,
  request: StabilizePipelineRequest,
  plan: StabilizationPlan,
  geometry: SourceGeometry,
  pixelScale: number,
): Promise<RenderOutcome> {
  const { sourceFps, range } = request
  const throwIfCancelled = request.throwIfCancelled ?? noop
  const onProgress = request.onProgress ?? noop
  const { width, height, totalSeconds } = geometry
  const { input, sink } = await openVideoSource(mb, request.source)
  // Everything downstream lives on the output's own timeline, which starts at zero regardless of
  // where in the source the clip was taken from.
  const sourceOffset = range?.startSeconds ?? 0

  const target = createRenderCanvas(width, height)
  target.ctx.imageSmoothingEnabled = true
  target.ctx.imageSmoothingQuality = 'high'

  const encoder = await createMp4Encoder(mb, request.destination, {
    width,
    height,
    fps: sourceFps,
  }).catch((error: unknown) => {
    input.dispose()
    throw error
  })
  const { output, videoSource, codec, takeBuffer } = encoder

  // Every track must be declared before `start()`.
  const audio = await setupAudioCopy(
    mb,
    input,
    output,
    range ? { offsetSeconds: sourceOffset, endSeconds: range.endSeconds } : undefined,
  )
  await output.start()

  const queue = new EncodeQueue(videoSource)
  const gaps: number[] = []
  const progress = new RenderProgress(totalSeconds, sourceFps)
  let previousTimestamp: number | null = null
  let index = 0

  try {
    for await (const sample of sink.samples(range?.startSeconds, range?.endSeconds)) {
      throwIfCancelled()

      // The sample straddling the range's start begins fractionally before it. Muxers reject a
      // negative timestamp, and that frame is the clip's first frame, so it belongs at zero.
      const timestamp = Math.max(0, sample.timestamp - sourceOffset)
      const duration = sample.duration > 0 ? sample.duration : 1 / sourceFps
      // A decode that yields more frames than the analysis pass saw would otherwise warp by
      // `undefined`; holding the last correction keeps the tail of the clip consistent with what
      // came before it.
      const warp = plan.warps[Math.min(index, plan.warps.length - 1)]!
      const matrix = warpToCanvasMatrix(warp, plan.cropRatio, width, height, pixelScale)

      try {
        target.ctx.setTransform(1, 0, 0, 1, 0, 0)
        // The zoom guarantees full coverage, so this only ever shows through as a hairline at the
        // very edge on a frame the crop had to give ground on. Black is the least conspicuous
        // thing to find there.
        target.ctx.fillStyle = '#000'
        target.ctx.fillRect(0, 0, width, height)
        target.ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)
        sample.draw(target.ctx, 0, 0, width, height)
      } finally {
        sample.close()
      }
      target.ctx.setTransform(1, 0, 0, 1, 0, 0)

      // `VideoSample` copies the canvas, so overwriting it for the next frame is safe.
      await queue.add(new mb.VideoSample(target.canvas, { timestamp, duration }))
      await audio.pumpUntil(timestamp)

      const gap = previousTimestamp === null ? null : Math.max(timestamp - previousTimestamp, 1e-6)
      if (gap !== null) gaps.push(gap)
      previousTimestamp = timestamp
      index++

      progress.tick(performance.now(), gap)
      onProgress('rendering', progress.fraction, progress.etaSeconds)
    }

    await queue.drain()
    await audio.drain()

    const frameCount = queue.count
    if (frameCount === 0) throw new Error('Source produced no decodable video frames')
    await output.finalize()

    return {
      width,
      height,
      fps: medianFps(gaps, sourceFps),
      codec,
      frameCount,
      buffer: takeBuffer(),
    }
  } catch (error) {
    // Settle the in-flight encode before cancelling — an un-awaited rejected `add()` would
    // surface as an unhandled rejection.
    await queue.drain().catch(() => {})
    // `output.cancel()` releases the encoder and closes the writable. Without it a partial file
    // stays locked and a retry cannot reopen it.
    await output.cancel().catch(() => {})
    throw error
  } finally {
    input.dispose()
  }
}

/** Run both passes and report what the render actually managed to do. */
export async function runStabilizePipeline(
  request: StabilizePipelineRequest,
): Promise<StabilizePipelineOutcome> {
  const cropRatio = request.cropRatio ?? DEFAULT_CROP_RATIO
  const throwIfCancelled = request.throwIfCancelled ?? noop

  await ensureProResDecoderRegistered()
  const mb = await import('mediabunny')
  throwIfCancelled()
  request.onProgress?.('preparing', 0, null)

  const { motions, geometry, analysis } = await analyzeMotion(mb, request)
  throwIfCancelled()

  const plan = planStabilization(motions, analysis.width, analysis.height, { cropRatio })
  const attenuationFloor = plan.attenuation.length === 0 ? 1 : Math.min(...plan.attenuation)
  // The plan is expressed at the analysis resolution; the render happens at full size.
  const pixelScale = geometry.width / analysis.width

  const { buffer, ...rendered } = await renderStabilized(mb, request, plan, geometry, pixelScale)

  return {
    buffer,
    result: {
      ...rendered,
      cropRatio,
      attenuationFloor,
      segmentCount: plan.segmentCount,
      unmeasuredFrames: plan.unmeasuredFrames,
    },
  }
}

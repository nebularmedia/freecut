/**
 * Stabilize Worker
 *
 * Thin shell around `stabilize-pipeline`: it owns the job queue, cancellation, the OPFS scratch
 * file and the postMessage protocol, and nothing about how the picture is produced. The headless
 * harness drives the same pipeline through a different shell, so there is one render and not two.
 */

import { createLogger } from '@/shared/logging/logger'
import {
  DEFAULT_CROP_RATIO,
  STABILIZE_TMP_DIR,
  stabilizeTmpPath,
  type StabilizeResult,
  type StabilizeStage,
} from '../stabilize-constants'
import { runStabilizePipeline, type StabilizeSourceRange } from './stabilize-pipeline'
import {
  Cancelled,
  CancellationRegistry,
  getSourceBlobFromOpfs,
  OpfsScratch,
} from './render-support'

const logger = createLogger('StabilizeWorker')

export interface StabilizeRequest {
  type: 'stabilize'
  jobId: string
  source?: Blob
  sourceOpfsPath?: string
  sourceMimeType?: string
  /** Only a hint, for the ETA before the first frame decodes. The true rate is measured. */
  sourceFps: number
  /** Fraction of the frame kept. Lower steadies more and shows less. */
  cropRatio?: number
  /** Source span to render, in seconds. Omit for the whole file. */
  range?: StabilizeSourceRange
}

export interface StabilizeCancelRequest {
  type: 'cancel'
  jobId: string
}

export interface StabilizeProgressResponse {
  type: 'progress'
  jobId: string
  stage: StabilizeStage
  /** 0..1 within the current stage. */
  progress: number
  /** Seconds left in the current stage, or null while the rate estimate warms up. */
  etaSeconds?: number | null
}

export interface StabilizeCompleteResponse {
  type: 'complete'
  jobId: string
  opfsPath: string
  result: StabilizeResult
}

export interface StabilizeErrorResponse {
  type: 'error'
  jobId: string
  error: string
}

export interface StabilizeCancelledResponse {
  type: 'cancelled'
  jobId: string
}

export type StabilizeWorkerRequest = StabilizeRequest | StabilizeCancelRequest
export type StabilizeWorkerResponse =
  | StabilizeProgressResponse
  | StabilizeCompleteResponse
  | StabilizeErrorResponse
  | StabilizeCancelledResponse

const jobs = new CancellationRegistry()
const scratch = new OpfsScratch(STABILIZE_TMP_DIR)

function post(message: StabilizeWorkerResponse): void {
  self.postMessage(message)
}

async function stabilize(request: StabilizeRequest): Promise<void> {
  const { jobId } = request

  const source = request.source
    ? request.source
    : await getSourceBlobFromOpfs(request.sourceOpfsPath!, request.sourceMimeType)

  const writable = await scratch.createWritable(jobId)
  try {
    const { result } = await runStabilizePipeline({
      source,
      sourceFps: request.sourceFps,
      cropRatio: request.cropRatio ?? DEFAULT_CROP_RATIO,
      range: request.range,
      destination: { kind: 'stream', writable },
      throwIfCancelled: () => jobs.throwIfCancelled(jobId),
      onProgress: (stage, progress, etaSeconds) => {
        post({ type: 'progress', jobId, stage, progress, etaSeconds })
      },
    })

    logger.info('Stabilize complete', {
      jobId,
      frames: result.frameCount,
      segments: result.segmentCount,
      unmeasured: result.unmeasuredFrames,
      attenuationFloor: Number(result.attenuationFloor.toFixed(3)),
    })
    post({ type: 'complete', jobId, opfsPath: stabilizeTmpPath(jobId), result })
  } catch (error) {
    // The pipeline already cancelled the output, which closes the writable; the partial scratch
    // file is all that is left to clear.
    await scratch.remove(jobId)
    throw error
  }
}

self.onmessage = async (event: MessageEvent<StabilizeWorkerRequest>) => {
  const request = event.data

  if (request.type === 'cancel') {
    jobs.cancel(request.jobId)
    return
  }

  const { jobId } = request
  jobs.clear(jobId)

  try {
    await stabilize(request)
  } catch (error) {
    if (error instanceof Cancelled || jobs.isCancelled(jobId)) {
      await scratch.remove(jobId)
      post({ type: 'cancelled', jobId })
    } else {
      logger.error('Stabilize failed', { jobId, error })
      post({
        type: 'error',
        jobId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  } finally {
    jobs.clear(jobId)
  }
}

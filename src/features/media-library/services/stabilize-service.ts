/**
 * Drives stabilization jobs and imports each result into the media library.
 *
 * One job at a time, for the same reason the upscale service serializes: the render saturates the
 * machine, and a second concurrent job makes both slower without finishing either sooner. Here it
 * matters twice over, because each job decodes its source twice.
 *
 * Statuses are keyed by the *source* media id — that is what the user sees a spinner on. The
 * generated item arrives via `onMediaCreated`, which the store wires to `prependMediaItem`.
 */

import { createLogger } from '@/shared/logging/logger'
import { createManagedWorker } from '@/shared/utils/managed-worker'
import type { MediaMetadata } from '@/types/storage'
import {
  DEFAULT_CROP_RATIO,
  STABILIZE_TMP_DIR,
  STABILIZED_MEDIA_TAG,
  stabilizedFileName,
  type StabilizeResult,
  type StabilizeStage,
} from '../stabilize-constants'
import type { StabilizeWorkerRequest, StabilizeWorkerResponse } from '../workers/stabilize-worker'

const logger = createLogger('StabilizeService')

const PROGRESS_EMIT_INTERVAL_MS = 150
const PROGRESS_EMIT_MIN_DELTA = 0.01

/**
 * Below this the crop ran out and a visible amount of the original movement is still in the
 * result. Worth telling the user about rather than letting them wonder why it still moves.
 */
const PARTIAL_STABILIZATION_FLOOR = 0.85

type StabilizeStatus = 'generating' | 'ready' | 'error' | 'idle'

type StabilizeStatusListener = (
  mediaId: string,
  status: StabilizeStatus,
  progress?: number,
  stage?: StabilizeStage,
  etaSeconds?: number | null,
) => void

type StabilizeMediaListener = (
  media: MediaMetadata,
  projectId: string,
  result: StabilizeResult,
) => void

type StabilizeSourceLoader = () => Promise<Blob | null>
interface StabilizeOpfsSource {
  kind: 'opfs'
  path: string
  mimeType?: string
}
type StabilizeSourceInput = Blob | StabilizeSourceLoader | StabilizeOpfsSource

interface StabilizeRequestInput {
  /**
   * Reported against for statuses and progress. Normally the source media id; for a job started
   * from a timeline clip it is that clip's id, so two clips cut from one source can be stabilized
   * independently and each shows its own progress.
   */
  mediaId: string
  projectId: string
  fileName: string
  source: StabilizeSourceInput
  sourceFps: number
  /** Fraction of the frame kept. Lower steadies more and shows less. */
  cropRatio?: number
  /** Source span to render, in seconds. Omit for the whole file. */
  range?: { startSeconds: number; endSeconds: number }
  /**
   * Called once the render has been imported. Carries the new library item so a caller that
   * started the job for a specific clip can repoint that clip at it — the global `onMediaCreated`
   * listener cannot, because it has no idea which clip asked.
   */
  onImported?: (media: MediaMetadata, result: StabilizeResult) => void
}

interface Job extends StabilizeRequestInput {
  jobId: string
}

async function readTmpFile(jobId: string): Promise<File | null> {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(STABILIZE_TMP_DIR, { create: true })
    const handle = await dir.getFileHandle(`${jobId}.mp4`)
    return await handle.getFile()
  } catch {
    return null
  }
}

async function removeTmpFile(jobId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(STABILIZE_TMP_DIR, { create: true })
    await dir.removeEntry(`${jobId}.mp4`)
  } catch {
    // Already gone.
  }
}

export class StabilizeService {
  private readonly pendingJobs: Job[] = []
  private readonly jobsByMediaId = new Map<string, Job>()
  private activeJob: Job | null = null
  private readonly cancelledJobIds = new Set<string>()

  private statusListener: StabilizeStatusListener | null = null
  private mediaListener: StabilizeMediaListener | null = null
  private readonly lastEmit = new Map<string, { at: number; progress: number }>()

  private readonly workerManager = createManagedWorker({
    createWorker: () =>
      new Worker(new URL('../workers/stabilize-worker.ts', import.meta.url), { type: 'module' }),
    setupWorker: (worker) => {
      worker.onmessage = (event: MessageEvent<StabilizeWorkerResponse>) => {
        void this.handleWorkerMessage(event.data)
      }
      worker.onerror = (error) => logger.error('Stabilize worker error', { error })
      return () => {
        worker.onmessage = null
        worker.onerror = null
      }
    },
  })

  onStatusChange(listener: StabilizeStatusListener): void {
    this.statusListener = listener
  }

  onMediaCreated(listener: StabilizeMediaListener): void {
    this.mediaListener = listener
  }

  /**
   * Video only. There is no resolution ceiling the way there is for upscaling — the output is the
   * same size as the input, so anything the browser could decode and encode in the first place is
   * fair game.
   */
  canStabilizeMedia(mimeType: string): boolean {
    return mimeType.startsWith('video/')
  }

  isGenerating(mediaId: string): boolean {
    return this.jobsByMediaId.has(mediaId)
  }

  generate(request: StabilizeRequestInput): void {
    if (this.jobsByMediaId.has(request.mediaId)) return

    const job: Job = { ...request, jobId: crypto.randomUUID() }
    this.jobsByMediaId.set(request.mediaId, job)
    this.pendingJobs.push(job)
    this.statusListener?.(request.mediaId, 'generating', 0, 'preparing')
    void this.drain()
  }

  cancel(mediaId: string): void {
    const job = this.jobsByMediaId.get(mediaId)
    if (!job) return

    const queuedIndex = this.pendingJobs.findIndex((pending) => pending.jobId === job.jobId)
    if (queuedIndex >= 0) {
      this.pendingJobs.splice(queuedIndex, 1)
      this.finish(job, 'idle')
      return
    }

    this.cancelledJobIds.add(job.jobId)
    this.finish(job, 'idle')
    if (this.activeJob?.jobId === job.jobId) {
      this.post({ type: 'cancel', jobId: job.jobId })
    }
  }

  cancelAll(): void {
    for (const mediaId of [...this.jobsByMediaId.keys()]) {
      this.cancel(mediaId)
    }
  }

  private post(message: StabilizeWorkerRequest): void {
    this.workerManager.getWorker().postMessage(message)
  }

  /** Throttled: a render can emit thousands of progress ticks. */
  private emitProgress(
    job: Job,
    progress: number,
    stage: StabilizeStage,
    etaSeconds?: number | null,
  ): void {
    const last = this.lastEmit.get(job.jobId)
    const now = Date.now()
    if (
      last &&
      now - last.at < PROGRESS_EMIT_INTERVAL_MS &&
      Math.abs(progress - last.progress) < PROGRESS_EMIT_MIN_DELTA &&
      progress < 1
    ) {
      return
    }
    this.lastEmit.set(job.jobId, { at: now, progress })
    this.statusListener?.(job.mediaId, 'generating', progress, stage, etaSeconds)
  }

  private finish(job: Job, status: StabilizeStatus): void {
    this.jobsByMediaId.delete(job.mediaId)
    this.lastEmit.delete(job.jobId)
    this.statusListener?.(job.mediaId, status)
  }

  private async drain(): Promise<void> {
    if (this.activeJob) return
    const job = this.pendingJobs.shift()
    if (!job) return

    this.activeJob = job

    let source: Blob | undefined
    let sourceOpfsPath: string | undefined
    let sourceMimeType: string | undefined

    try {
      if (job.source instanceof Blob) {
        source = job.source
      } else if (typeof job.source === 'function') {
        const loaded = await job.source()
        if (!loaded) throw new Error('Source bytes unavailable')
        source = loaded
      } else {
        sourceOpfsPath = job.source.path
        sourceMimeType = job.source.mimeType
      }
    } catch (error) {
      this.activeJob = null
      if (this.cancelledJobIds.delete(job.jobId)) {
        void this.drain()
        return
      }
      logger.error('Stabilize source load failed', { mediaId: job.mediaId, error })
      this.finish(job, 'error')
      void this.drain()
      return
    }

    if (this.cancelledJobIds.delete(job.jobId)) {
      this.activeJob = null
      await removeTmpFile(job.jobId)
      void this.drain()
      return
    }

    this.post({
      type: 'stabilize',
      jobId: job.jobId,
      source,
      sourceOpfsPath,
      sourceMimeType,
      sourceFps: job.sourceFps,
      cropRatio: job.cropRatio ?? DEFAULT_CROP_RATIO,
      range: job.range,
    })
  }

  private async handleWorkerMessage(message: StabilizeWorkerResponse): Promise<void> {
    const job = this.activeJob
    if (!job || job.jobId !== message.jobId) return

    if (message.type === 'progress') {
      if (!this.cancelledJobIds.has(job.jobId)) {
        this.emitProgress(job, message.progress, message.stage, message.etaSeconds)
      }
      return
    }

    this.activeJob = null

    try {
      if (this.cancelledJobIds.has(job.jobId)) {
        await removeTmpFile(job.jobId)
      } else if (message.type === 'complete') {
        await this.importResult(job, message.result)
      } else if (message.type === 'error') {
        logger.error('Stabilize failed', { mediaId: job.mediaId, error: message.error })
        this.finish(job, 'error')
      } else {
        this.finish(job, 'idle')
      }
    } finally {
      this.cancelledJobIds.delete(job.jobId)
      void this.drain()
    }
  }

  private async importResult(job: Job, result: StabilizeResult): Promise<void> {
    try {
      const rendered = await readTmpFile(job.jobId)
      if (this.cancelledJobIds.has(job.jobId)) return
      if (!rendered || rendered.size === 0) {
        throw new Error('Stabilize render produced no file')
      }

      const file = new File([rendered], stabilizedFileName(job.fileName), { type: 'video/mp4' })
      // Imported lazily. The media-library store imports this service, so a static import would
      // drag media-library-service's whole graph (mediabunny, OPFS, thumbnails) into every
      // consumer of the store.
      const { mediaLibraryService } = await import('./media-library-service')
      if (this.cancelledJobIds.has(job.jobId)) return
      const media = await mediaLibraryService.importGeneratedVideo(file, job.projectId, {
        fps: result.fps,
        tags: [STABILIZED_MEDIA_TAG],
      })

      if (this.cancelledJobIds.has(job.jobId)) {
        await mediaLibraryService.deleteMediaFromProject(job.projectId, media.id)
        return
      }

      this.mediaListener?.(media, job.projectId, result)
      job.onImported?.(media, result)
      this.finish(job, 'ready')

      if (result.attenuationFloor < PARTIAL_STABILIZATION_FLOOR) {
        logger.warn('Stabilization was limited by the crop budget', {
          mediaId: media.id,
          attenuationFloor: Number(result.attenuationFloor.toFixed(3)),
          cropRatio: result.cropRatio,
        })
      }
      logger.info('Stabilized media imported', {
        sourceMediaId: job.mediaId,
        mediaId: media.id,
        segments: result.segmentCount,
        unmeasuredFrames: result.unmeasuredFrames,
      })
    } catch (error) {
      if (this.cancelledJobIds.has(job.jobId)) {
        logger.error('Failed to roll back cancelled stabilize import', {
          mediaId: job.mediaId,
          error,
        })
        return
      }
      logger.error('Failed to import stabilized media', { mediaId: job.mediaId, error })
      this.finish(job, 'error')
    } finally {
      await removeTmpFile(job.jobId)
    }
  }
}

export const stabilizeService = new StabilizeService()

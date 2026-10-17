// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { MediaMetadata } from '@/types/storage'
import type { StabilizeResult } from '../stabilize-constants'
import { StabilizeService } from './stabilize-service'

const mediaLibraryServiceMocks = vi.hoisted(() => ({
  importGeneratedVideo: vi.fn(),
  deleteMediaFromProject: vi.fn(async () => {}),
}))

vi.mock('./media-library-service', () => ({
  mediaLibraryService: mediaLibraryServiceMocks,
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const job = {
  mediaId: 'source-1',
  projectId: 'project-1',
  fileName: 'source.mp4',
  source: new Blob(['source']),
  sourceFps: 30,
  cropRatio: 0.9,
  jobId: 'job-1',
}

const result: StabilizeResult = {
  width: 1920,
  height: 1080,
  fps: 30,
  codec: 'avc',
  frameCount: 300,
  cropRatio: 0.9,
  attenuationFloor: 1,
  segmentCount: 1,
  unmeasuredFrames: 0,
}

function seedJob(service: StabilizeService, active: boolean) {
  const internals = service as unknown as {
    activeJob: typeof job | null
    jobsByMediaId: Map<string, typeof job>
  }
  internals.activeJob = active ? job : null
  internals.jobsByMediaId.set(job.mediaId, job)
}

function makeMedia(): MediaMetadata {
  return {
    id: 'generated-1',
    storageType: 'opfs',
    fileName: 'generated.mp4',
    fileSize: 10,
    mimeType: 'video/mp4',
    duration: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'avc',
    bitrate: 1,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('StabilizeService', () => {
  const removeEntry = vi.fn(async () => {})

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => ({
          getDirectoryHandle: vi.fn(async () => ({
            getFileHandle: vi.fn(async () => ({
              getFile: vi.fn(async () => new File(['rendered'], 'job-1.mp4')),
            })),
            removeEntry,
          })),
        })),
      },
    })
  })

  it('offers stabilization for video and nothing else', () => {
    const service = new StabilizeService()

    expect(service.canStabilizeMedia('video/mp4')).toBe(true)
    expect(service.canStabilizeMedia('video/webm')).toBe(true)
    expect(service.canStabilizeMedia('audio/mpeg')).toBe(false)
    expect(service.canStabilizeMedia('image/png')).toBe(false)
  })

  it('ignores a complete message that races with active cancellation', async () => {
    const service = new StabilizeService()
    seedJob(service, true)
    const internals = service as unknown as {
      post(message: unknown): void
      importResult(activeJob: typeof job, outcome: StabilizeResult): Promise<void>
    }
    const post = vi.spyOn(internals, 'post').mockImplementation(() => undefined)
    const importResult = vi.spyOn(internals, 'importResult').mockResolvedValue(undefined)

    service.cancel(job.mediaId)
    await (
      service as unknown as {
        handleWorkerMessage(message: unknown): Promise<void>
      }
    ).handleWorkerMessage({
      type: 'complete',
      jobId: job.jobId,
      opfsPath: 'stabilize-tmp/job-1.mp4',
      result,
    })

    expect(post).toHaveBeenCalledWith({ type: 'cancel', jobId: job.jobId })
    expect(importResult).not.toHaveBeenCalled()
    expect(service.isGenerating(job.mediaId)).toBe(false)
  })

  it('rolls back media when cancellation lands during import', async () => {
    const service = new StabilizeService()
    seedJob(service, false)
    const imported = createDeferred<MediaMetadata>()
    mediaLibraryServiceMocks.importGeneratedVideo.mockReturnValue(imported.promise)
    const onMediaCreated = vi.fn()
    service.onMediaCreated(onMediaCreated)

    const importPromise = (
      service as unknown as {
        importResult(activeJob: typeof job, outcome: StabilizeResult): Promise<void>
      }
    ).importResult(job, result)
    await vi.waitFor(() => expect(mediaLibraryServiceMocks.importGeneratedVideo).toHaveBeenCalled())

    service.cancel(job.mediaId)
    imported.resolve(makeMedia())
    await importPromise

    expect(mediaLibraryServiceMocks.deleteMediaFromProject).toHaveBeenCalledWith(
      job.projectId,
      'generated-1',
    )
    expect(onMediaCreated).not.toHaveBeenCalled()
  })

  it('names the import after the source and tags its provenance', async () => {
    const service = new StabilizeService()
    seedJob(service, false)
    mediaLibraryServiceMocks.importGeneratedVideo.mockResolvedValue(makeMedia())

    await (
      service as unknown as {
        importResult(activeJob: typeof job, outcome: StabilizeResult): Promise<void>
      }
    ).importResult(job, result)

    const [file, projectId, options] = mediaLibraryServiceMocks.importGeneratedVideo.mock.calls[0]!
    expect((file as File).name).toBe('source (stabilized).mp4')
    expect(projectId).toBe('project-1')
    expect(options).toMatchObject({ fps: 30, tags: ['stabilized'] })
    // The scratch render is cleaned up whether or not the import succeeded.
    expect(removeEntry).toHaveBeenCalledWith('job-1.mp4')
  })

  it('hands the strength through to the worker as a crop ratio', () => {
    const service = new StabilizeService()
    const internals = service as unknown as { post(message: unknown): void }
    const post = vi.spyOn(internals, 'post').mockImplementation(() => undefined)

    service.generate({
      mediaId: 'source-2',
      projectId: 'project-1',
      fileName: 'clip.mp4',
      source: new Blob(['bytes']),
      sourceFps: 24,
      cropRatio: 0.85,
    })

    return vi.waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stabilize', cropRatio: 0.85, sourceFps: 24 }),
      )
    })
  })

  it('refuses to queue the same media twice', () => {
    const service = new StabilizeService()
    const internals = service as unknown as { post(message: unknown): void }
    vi.spyOn(internals, 'post').mockImplementation(() => undefined)

    const request = {
      mediaId: 'source-3',
      projectId: 'project-1',
      fileName: 'clip.mp4',
      source: new Blob(['bytes']),
      sourceFps: 30,
    }
    service.generate(request)
    service.generate(request)

    expect(service.isGenerating('source-3')).toBe(true)
    // Cancelling once is enough to clear it; a duplicate job would leave a second one behind.
    service.cancel('source-3')
    expect(service.isGenerating('source-3')).toBe(false)
  })
})

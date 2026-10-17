import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('ImagePreviewCache')

/**
 * A small copy of a photo, for painting the editor with.
 *
 * WHY THIS EXISTS — 2026-09-03. A timeline clip painted its picture from the
 * ORIGINAL file, which for a camera photo is 8-24 megapixels. A photo reel is
 * made of dozens of them and every clip wide enough to show a filmstrip holds
 * its own decode, so the tab carried the whole shoot uncompressed at once: a
 * 29-photo reel measured 267 MP, about 1 GB of bitmap, and the editor died
 * before it could be edited.
 *
 * A filmstrip tile is ~50 px tall and the preview canvas is 1080 px wide, so
 * none of that resolution was ever on screen. THE EXPORT NEVER COMES THROUGH
 * HERE — it resolves media with `useProxy: false` and gets the original file,
 * untouched — which is the same split the video proxies already use.
 *
 * The copy lives in memory for the session, like a blob URL: rebuilding it on
 * the next load costs one decode per photo, and keeping it on disk would mean
 * writing to the media record of a file the montage pipeline wrote.
 */

/** Longest side of the copy. Four times a filmstrip tile, so zoom stays sharp. */
const IMAGE_PREVIEW_MAX_EDGE_PX = 640

/**
 * Below this the original is already small enough to paint with, and a copy
 * would cost a decode to save nothing. 4 MP is a 2048x2048 photo — twice the
 * canvas of a vertical reel.
 */
const IMAGE_PREVIEW_MIN_SOURCE_PIXELS = 4_000_000

function fits(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  const longest = Math.max(sourceWidth, sourceHeight)
  const factor = IMAGE_PREVIEW_MAX_EDGE_PX / longest
  return {
    width: Math.max(1, Math.round(sourceWidth * factor)),
    height: Math.max(1, Math.round(sourceHeight * factor)),
  }
}

function canBuild(): boolean {
  return typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
}

/**
 * How many copies are built at the same time.
 *
 * It has to be a queue and not a free-for-all: every clip on screen asks for
 * its copy the moment it mounts, so 29 photos would start 29 decodes at once
 * and rebuild, for a few seconds, exactly the gigabyte this file exists to
 * avoid. Two keeps the decoder busy without ever holding more than two
 * pictures.
 */
const MAX_BUILDS_AT_ONCE = 2

class ImagePreviewCache {
  private urls = new Map<string, string>()
  private building = new Map<string, Promise<string | null>>()
  private running = 0
  private waiting: Array<() => void> = []

  /** Waits for a turn. Resolves immediately while there is room. */
  private takeTurn(): Promise<void> {
    if (this.running < MAX_BUILDS_AT_ONCE) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  private giveTurnBack(): void {
    const next = this.waiting.shift()
    if (next) {
      next()
      return
    }
    this.running = Math.max(0, this.running - 1)
  }

  /** The copy for `mediaId`, or null while there isn't one. Never throws. */
  get(mediaId: string): string | null {
    return this.urls.get(mediaId) ?? null
  }

  /**
   * The copy for `mediaId`, building it the first time it is asked for.
   *
   * Returns null when there is nothing to gain (a photo already small, a
   * browser without `OffscreenCanvas`) or when the build fails: every caller
   * falls back to the original, so a copy that can't be made costs nothing but
   * the memory it was going to save.
   */
  async resolve(
    mediaId: string,
    sourceUrl: string,
    sourceWidth: number,
    sourceHeight: number,
  ): Promise<string | null> {
    const cached = this.urls.get(mediaId)
    if (cached) return cached

    if (!sourceUrl || !canBuild()) return null
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) return null
    if (sourceWidth * sourceHeight < IMAGE_PREVIEW_MIN_SOURCE_PIXELS) return null

    const started = this.building.get(mediaId)
    if (started) return started

    const build = this.build(mediaId, sourceUrl, sourceWidth, sourceHeight).finally(() => {
      this.building.delete(mediaId)
    })
    this.building.set(mediaId, build)
    return build
  }

  private async build(
    mediaId: string,
    sourceUrl: string,
    sourceWidth: number,
    sourceHeight: number,
  ): Promise<string | null> {
    const { width, height } = fits(sourceWidth, sourceHeight)
    await this.takeTurn()

    // Someone else may have built it while this one waited for its turn.
    const built = this.urls.get(mediaId)
    if (built) {
      this.giveTurnBack()
      return built
    }

    let bitmap: ImageBitmap | undefined
    try {
      const blob = await (await fetch(sourceUrl)).blob()
      // resizeWidth/Height let the decoder scale as it reads, so the full-size
      // bitmap never has to exist — which is the whole point of this file.
      bitmap = await createImageBitmap(blob, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high',
      })
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')
      if (!context) return null
      context.drawImage(bitmap, 0, 0)
      const small = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })

      // Two clips of the same photo race here; the first URL wins and the
      // second is revoked instead of leaking.
      const raced = this.urls.get(mediaId)
      if (raced) return raced
      const url = URL.createObjectURL(small)
      this.urls.set(mediaId, url)
      return url
    } catch (error) {
      logger.warn('Could not build the preview copy; painting from the original', {
        mediaId,
        error,
      })
      return null
    } finally {
      bitmap?.close()
      this.giveTurnBack()
    }
  }

  /** Drops every copy. For closing a project, and for the tests. */
  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
    this.building.clear()
    this.running = 0
    this.waiting = []
  }
}

export const imagePreviewCache = new ImagePreviewCache()

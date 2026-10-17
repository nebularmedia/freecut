import type { MediaMetadata } from '@/types/storage'
import { proxyService } from '../services/proxy-service'
import { getSharedProxyKey } from './proxy-key'
import { isHeavyForPreview, type HeavyMediaVerdict } from './heavy-media'
import { createLogger } from '@/shared/logging/logger'

const log = createLogger('MediaLibrary:AutoProxy')

/**
 * Queue proxies for the media that is too heavy to preview from the original.
 *
 * This is the automatic half of a feature that already existed by hand: the
 * media card, the library's bulk action and the settings dialog all call
 * `proxyService.generateProxy`, and all three are buttons. Nothing measured
 * whether a proxy was *needed*, so the editor stuttered until someone knew to
 * go and press one.
 *
 * Three things keep this from being annoying:
 *
 * 1. **It queues at `background` priority.** The proxy service already runs one
 *    job at a time and lets a hand-pressed job jump the queue, so ten heavy
 *    clips landing at once does not turn into ten transcodes at once — which
 *    would make the very stutter this exists to fix considerably worse.
 * 2. **It never re-queues.** Anything already `ready` or `generating`, or that
 *    the service already holds a blob for, is skipped. A failed proxy is not
 *    retried either: the service deliberately does not requeue failures, and
 *    quietly retrying a transcode that just failed on every project open is how
 *    a background task becomes a fan that never stops.
 * 3. **The caller decides whether to say anything.** The count comes back so
 *    the store can put a line on screen — the user asked to be told, because a
 *    machine that starts working on its own without saying so reads as broken.
 */
export interface AutoProxyResult {
  /** How many proxies were actually queued by this call. */
  queued: number
  /** The verdicts, for the log line. Only the heavy ones. */
  verdicts: Array<{ id: string; fileName: string } & HeavyMediaVerdict>
}

export function queueProxiesForHeavyMedia(
  items: readonly MediaMetadata[],
  loadFile: (mediaId: string) => Promise<Blob | null>,
): AutoProxyResult {
  const verdicts: AutoProxyResult['verdicts'] = []
  let queued = 0

  for (const item of items) {
    const verdict = isHeavyForPreview(item)
    if (!verdict.heavy) continue
    if (!proxyService.canGenerateProxy(item.mimeType)) continue

    const proxyKey = getSharedProxyKey(item)
    // `hasProxy` covers the copy already on disk from a previous session; the
    // status map covers one queued a moment ago in this one.
    if (proxyService.hasProxy(item.id, proxyKey)) continue

    verdicts.push({ id: item.id, fileName: item.fileName, ...verdict })

    try {
      proxyService.setProxyKey(item.id, proxyKey)
      proxyService.generateProxy(
        item.id,
        item.storageType === 'opfs' && item.opfsPath
          ? { kind: 'opfs', path: item.opfsPath, mimeType: item.mimeType }
          : async () => loadFile(item.id),
        item.width,
        item.height,
        proxyKey,
        { priority: 'background' },
      )
      queued += 1
    } catch (error) {
      // A proxy that fails to even start is not worth interrupting anyone
      // over: the original still plays, just slowly. It goes to the log.
      log.warn('Could not queue automatic proxy', { mediaId: item.id, error })
    }
  }

  if (verdicts.length > 0) {
    log.info('Heavy media found', {
      queued,
      clips: verdicts.map((v) => `${v.fileName} ${v.megapixelsPerSecond}Mpx/s (${v.reason})`),
    })
  }

  return { queued, verdicts }
}

/**
 * Ask the browser to make this origin's storage non-evictable.
 *
 * WHY THIS MATTERS MORE HERE THAN IN A NORMAL WEB APP
 *
 * A workspace lives on the user's disk, so none of their work is at risk. What
 * lives in browser storage is the `FileSystemDirectoryHandle` — the *permission*
 * to reach that folder without asking again. A handle cannot be serialized to a
 * path and rebuilt; it is an opaque capability bound to origin + profile. Lose
 * it and nothing is destroyed, but every workspace has to be picked by hand
 * again, one directory picker at a time.
 *
 * Without a `persist()` grant that storage is best-effort, and the browser is
 * free to evict it under disk pressure — which is exactly when a video editor's
 * user is most likely to be short on space.
 *
 * BEST EFFORT BY DESIGN. Chromium decides from its own heuristics (installed
 * PWA, bookmark, engagement) and can answer `false` without a prompt; Firefox
 * may ask the user. Either way this never throws and never blocks: a denied
 * request leaves the app working exactly as it did before.
 */

import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('PersistentStorage')

let inFlight: Promise<boolean> | null = null

/**
 * Request persistent storage once per session, returning whether the origin is
 * persisted. Safe to call from anywhere and as often as you like — the result
 * is memoized, so repeated calls cost nothing and cannot stack up prompts.
 */
export function ensurePersistentStorage(): Promise<boolean> {
  inFlight ??= requestOnce()
  return inFlight
}

async function requestOnce(): Promise<boolean> {
  if (!navigator.storage?.persist || !navigator.storage.persisted) {
    return false
  }

  try {
    // Asking again when it is already granted is harmless, but checking first
    // keeps the log honest about which of the two happened.
    if (await navigator.storage.persisted()) {
      logger.debug('Storage already persisted')
      return true
    }

    const granted = await navigator.storage.persist()
    // Two levels on purpose. A grant is a fact you never need to act on; a
    // denial means the workspace handles can be evicted, and that is worth
    // seeing. It matters because a production build starts the logger at WARN,
    // so anything below it is dropped — on 2026-08-13 the denial went out as
    // `info` and four rounds were spent looking for a message that could not
    // appear. The level IS the interface here.
    if (granted) {
      logger.info('Storage is now persisted — workspace permissions survive disk pressure')
    } else {
      logger.warn(
        'Storage persistence denied by the browser — workspace permissions may be evicted ' +
          'under disk pressure. Nothing is lost if that happens: the folders have to be picked again.',
      )
    }
    return granted
  } catch (error) {
    logger.warn('Storage persistence request failed', error)
    return false
  }
}

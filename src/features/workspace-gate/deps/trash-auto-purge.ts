/**
 * Adapter layer: run the auto-purge sweep of trashed projects.
 *
 * The workspace-gate owns app bootstrap; it shouldn't reach into the
 * projects feature directly. This adapter wires `sweepTrashOlderThan`
 * (infrastructure) with `permanentlyDeleteProject` (projects feature)
 * behind a single entry point the gate imports.
 *
 * Schedule: fires once per app activation (after workspace handle is
 * granted and bootstrap completes). Cheap when trash is empty — one
 * `listDirectory` call on `projects/` and one marker read per project.
 */

import { createLogger } from '@/shared/logging/logger'
import {
  DEFAULT_TRASH_TTL_MS,
  projectHasAdoptedIdea,
  sweepTrashOlderThan,
} from '@/infrastructure/storage'
import { useProjectStore } from './projects-contract'

const logger = createLogger('TrashAutoPurge')

export async function autoPurgeExpiredTrash(ttlMs: number = DEFAULT_TRASH_TTL_MS): Promise<void> {
  try {
    const { permanentlyDeleteProject } = useProjectStore.getState()
    // Ids the sweep walked over but did not remove. `sweepTrashOlderThan`
    // counts every `onPurge` that returns without throwing, so a skip has to be
    // subtracted here or the log would claim a deletion that never happened.
    const skipped = new Set<string>()
    const swept = await sweepTrashOlderThan(ttlMs, async (id) => {
      // A project holding an adopted idea (`_idea/`) is skipped, not purged.
      // `permanentlyDeleteProject` refuses it anyway, but skipping keeps it out
      // of the error path: this sweep runs unattended on every workspace
      // activation, and a project the factory deliberately protects is not a
      // failure to log once a day forever. It stays in the trash, visible and
      // restorable, until someone sends its idea back to the bucket.
      if (await projectHasAdoptedIdea(id)) {
        skipped.add(id)
        logger.info(`Auto-purge skipped ${id}: still holds its idea folder`)
        return
      }
      await permanentlyDeleteProject(id)
    })
    const purged = swept.filter((id) => !skipped.has(id))
    if (purged.length > 0) {
      logger.info(`Auto-purge removed ${purged.length} trashed project(s) past TTL`)
      // Refresh the store's visible list in case any purge affected it.
      // (It shouldn't — purged projects were already hidden — but this
      // keeps things tidy if state drifted.)
      await useProjectStore.getState().loadProjects()
    }
  } catch (error) {
    logger.warn('autoPurgeExpiredTrash failed', error)
  }
}

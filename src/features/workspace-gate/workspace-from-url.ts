/**
 * Open a named workspace straight from the URL: `?workspace=<folder name>`.
 *
 * Added for the content factory, which drives this editor from another app: its
 * board links directly to `/editor/<projectId>`, and a project id only resolves
 * inside the workspace that project lives in. There is one workspace per brand,
 * so following a link while a different one is active lands on "project not
 * found" — and from there the fix (switch workspace, navigate again) is
 * invisible. Naming the workspace in the link removes the step entirely.
 *
 * Only an already-known workspace can be activated. A directory handle is a
 * permission the browser granted, not a path we can rebuild from a string, so
 * an unknown name is a deliberate no-op: the gate falls through to its normal
 * pick/reconnect splash and the first pick is what teaches us the handle.
 */

import {
  activateWorkspaceHandle,
  getWorkspaceHandleRecord,
  listKnownWorkspaces,
} from '@/infrastructure/storage/handles-db'
import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('WorkspaceFromUrl')

export const WORKSPACE_PARAM = 'workspace'

/**
 * Activate the workspace named in `?workspace=`, if there is one and it is
 * known. Resolves to `true` only when the active workspace actually changed —
 * the caller re-reads the current record either way.
 */
export async function activateWorkspaceFromUrl(): Promise<boolean> {
  if (typeof window === 'undefined') return false

  const wanted = new URLSearchParams(window.location.search).get(WORKSPACE_PARAM)?.trim()
  if (!wanted) return false

  const known = await listKnownWorkspaces()
  // Matched by folder name, not by the internal uuid: the name is the only
  // thing the linking app can know without reading this browser's IndexedDB.
  const match = known.find((record) => record.name.toLowerCase() === wanted.toLowerCase())
  if (!match) {
    logger.warn(`Workspace "${wanted}" is not known yet — pick it once and the link will work.`)
    return false
  }

  const current = await getWorkspaceHandleRecord()
  if (current?.activeWorkspaceId === match.id) return false

  const activated = await activateWorkspaceHandle(match.id)
  if (!activated) {
    logger.warn(`Workspace "${wanted}" is listed but its handle is gone.`)
    return false
  }
  return true
}

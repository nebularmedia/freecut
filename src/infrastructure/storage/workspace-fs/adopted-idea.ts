/**
 * Polimake fork addition — projects that carry an adopted idea.
 *
 * In the content factory a video project is not only a montage. When an idea
 * leaves the ideas bucket, its whole folder is MOVED inside the project as
 * `projects/{id}/_idea/`, holding the `idea.md` with the brief, the angle and
 * the reference links. That is the ONLY copy: LocalStudio reads the pipeline
 * straight from there (`leerEnProduccion`), which makes the project directory
 * part of the factory, not just editor state.
 *
 * The consequence is the reason this module exists. `deleteProject` wipes
 * `projects/{id}/` recursively, so permanently deleting such a project destroys
 * the idea along with the timeline — no trash, no trace, and often nobody asked
 * for it, because the auto-purge sweep fires on its own once the trash TTL
 * expires. The house rule is the opposite: nothing disappears unless a human
 * deletes it, and every move leaves a trace.
 *
 * So permanent deletion refuses while `_idea/` is in there. Soft-delete keeps
 * working — trashing hides the project and leaves the directory intact, which
 * is what "delete" should mean for this kind of project. To really let one go,
 * the idea goes back to the bucket first (LocalStudio's "devolver la idea al
 * bucket"); after that it is an ordinary project and deletes like any other.
 *
 * Kept in its own module so the fork's footprint in upstream files stays at one
 * import and one guard per touchpoint.
 */

import { listDirectory } from './fs-primitives'
import { projectDir } from './paths'
import { requireWorkspaceRoot } from './root'

/**
 * Name of the idea folder inside a project. Mirrors `video.carpetaIdea` in
 * the factory's `factory.config.json` — if that ever changes, this changes.
 */
const ADOPTED_IDEA_DIR = '_idea'

/**
 * Refusal to destroy a project that holds the only copy of an idea. Its own
 * class so a reader of the logs can tell it apart from a filesystem failure —
 * this one is not a retryable error, it's an answer. Module-local on purpose:
 * nothing catches it by type, and an export nobody imports is one more thing
 * the unused-export ratchet has to carry.
 */
class AdoptedIdeaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdoptedIdeaError'
  }
}

/**
 * Whether this project holds an adopted idea. One listing of the project
 * directory — half a dozen entries, so it is cheap enough to sit in front of
 * every delete.
 *
 * NOT `exists()`: that helper tries `getFileHandle` first, and on a directory
 * the File System Access API answers `TypeMismatchError`, which it rethrows
 * rather than treating as "not a file, keep looking". It works for files only.
 */
export async function projectHasAdoptedIdea(id: string): Promise<boolean> {
  const root = requireWorkspaceRoot()
  const entries = await listDirectory(root, projectDir(id))
  return entries.some((e) => e.name === ADOPTED_IDEA_DIR && e.kind === 'directory')
}

/**
 * Guard for every code path that removes a project directory for good. Call it
 * BEFORE any destructive step — media cleanup included, since that is already
 * irreversible by the time the directory removal would refuse.
 */
export async function assertNoAdoptedIdea(id: string, name?: string): Promise<void> {
  if (!(await projectHasAdoptedIdea(id))) return
  const which = name ? `"${name}"` : id
  throw new AdoptedIdeaError(
    `Project ${which} still holds its idea (${ADOPTED_IDEA_DIR}/) and was NOT deleted. ` +
      'That folder is the only copy of the brief. Send the idea back to the ideas ' +
      'bucket from LocalStudio first, then delete this project.',
  )
}

/**
 * Which frame represents a project.
 *
 * The project cover used to be "whatever the playhead happened to be showing
 * when you hit save". That is not a property of the montage — it is a property
 * of where you left the cursor — so the same project got a different cover on
 * every save, and parking the playhead on a gap saved a black rectangle.
 *
 * The cover is derived from the timeline instead: the FIRST thing the montage
 * shows, a beat after it starts. The beat matters — clip one usually opens on a
 * fade, and frame zero of a fade is black.
 */

import type { TimelineItem, TimelineTrack } from '@/types/timeline'

/** Item types that put pixels of their own on the canvas. */
const PICTURE_TYPES = new Set(['video', 'image', 'lottie', 'shape', 'composition'])

/** How far into the opening item to look, in seconds. Enough to clear a fade. */
const SETTLE_SECONDS = 0.5

/**
 * The frame to use as the project cover.
 *
 * Prefers the opening PICTURE — a cover made of a title over black says
 * nothing on a card, and the picture is what makes a project recognisable in a
 * list. Falls back to the opening item of any kind, and to frame 0 for a
 * timeline with nothing in it.
 *
 * Never lands past the middle of the item it picked, so a very short opening
 * clip is still sampled inside itself.
 */
export function resolveCoverFrame(
  items: readonly TimelineItem[],
  tracks: readonly TimelineTrack[],
  fps: number,
): number {
  const hidden = new Set(tracks.filter((track) => track.visible === false).map((track) => track.id))
  const visible = items.filter((item) => !hidden.has(item.trackId))
  const opening =
    earliest(visible.filter((item) => PICTURE_TYPES.has(item.type))) ?? earliest(visible)
  if (!opening) return 0

  const from = Math.max(0, Math.round(opening.from ?? 0))
  const duration = Math.max(1, Math.round(opening.durationInFrames ?? 1))
  const settle = Math.round((Number.isFinite(fps) && fps > 0 ? fps : 30) * SETTLE_SECONDS)
  return from + Math.min(settle, Math.floor(duration / 2))
}

/** The item that starts first; ties broken by id so the result is stable. */
function earliest(items: readonly TimelineItem[]): TimelineItem | null {
  let best: TimelineItem | null = null
  for (const item of items) {
    if (!best) {
      best = item
      continue
    }
    const delta = (item.from ?? 0) - (best.from ?? 0)
    if (delta < 0 || (delta === 0 && item.id < best.id)) best = item
  }
  return best
}

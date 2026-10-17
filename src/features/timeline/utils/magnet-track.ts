import type { TimelineItem, TimelineTrack } from '@/types/timeline'
import { getTrackKind } from './classic-tracks'
import { getLinkedItemIds } from './linked-items'

/**
 * CapCut's main track magnet.
 *
 * In CapCut the bottom video track is the spine of the edit: it never holds a
 * gap, and dropping a clip into it inserts rather than overwrites — everything
 * downstream shifts to make room. This module works out where a dropped clip
 * lands in that order and where every clip on the track ends up afterwards.
 *
 * Clips linked to a magnet-track clip (a detached audio companion, a caption)
 * ride the same shift, so a repack can never pull sound off picture.
 */

/** The magnet track is the lowest video track — CapCut's "main track". */
export function getMagnetTrackId(tracks: TimelineTrack[]): string | null {
  const videoTracks = tracks
    .filter((track) => !track.isGroup && getTrackKind(track) === 'video')
    .sort((left, right) => left.order - right.order)

  return videoTracks[0]?.id ?? null
}

interface MagnetPlacementParams {
  items: TimelineItem[]
  trackId: string
  /** The clip being dropped. It may be arriving from another track. */
  movedItemId: string
  /** Where the drop left the clip's head, in frames. */
  dropFrame: number
}

export interface MagnetPlacement {
  /** Where the dropped clip ends up. */
  movedFrom: number
  /** Every clip that has to move, the dropped one included. */
  updates: Array<{ id: string; from: number; trackId?: string }>
}

/**
 * Lay the magnet track out end to end with the dropped clip slotted in.
 *
 * The insertion point is the first clip whose midpoint the drop passes, which
 * is what makes dragging a clip a few frames past its neighbour swap the two
 * instead of nudging it.
 */
export function planMagnetPlacement({
  items,
  trackId,
  movedItemId,
  dropFrame,
}: MagnetPlacementParams): MagnetPlacement | null {
  const moved = items.find((item) => item.id === movedItemId)
  if (!moved) return null

  const others = items
    .filter((item) => item.trackId === trackId && item.id !== movedItemId)
    .sort((left, right) => left.from - right.from)

  const insertIndex = others.findIndex((item) => dropFrame < item.from + item.durationInFrames / 2)
  const ordered = [...others]
  ordered.splice(insertIndex === -1 ? ordered.length : insertIndex, 0, moved)

  const updates: MagnetPlacement['updates'] = []
  let cursor = 0
  let movedFrom = 0

  for (const item of ordered) {
    const isMovedItem = item.id === movedItemId
    if (isMovedItem) movedFrom = cursor

    const changedTrack = item.trackId !== trackId
    if (item.from !== cursor || changedTrack) {
      const delta = cursor - item.from
      updates.push({ id: item.id, from: cursor, ...(changedTrack ? { trackId } : {}) })

      // Carry linked companions along so a repack cannot desync A/V.
      for (const linkedId of getLinkedItemIds(items, item.id)) {
        // The anchor is part of its own link group, and it already moved above.
        if (linkedId === item.id) continue
        const linked = items.find((entry) => entry.id === linkedId)
        if (!linked || linked.trackId === trackId) continue
        updates.push({ id: linkedId, from: Math.max(0, linked.from + delta) })
      }
    }

    cursor += item.durationInFrames
  }

  return { movedFrom, updates }
}

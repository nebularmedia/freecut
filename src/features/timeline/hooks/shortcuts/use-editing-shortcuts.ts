/**
 * Editing shortcuts: Delete, Ripple Delete, Join, Split, Keyframes.
 */

import { useCallback } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { usePlaybackStore } from '@/shared/state/playback'
import { useEditorStore } from '@/shared/state/editor'
import { useTimelineStore } from '../../stores/timeline-store'
import { useSelectionStore } from '@/shared/state/selection'
import { HOTKEY_OPTIONS } from '@/config/hotkeys'
import { canJoinMultipleItems } from '@/features/timeline/utils/clip-utils'
import { clampAudioVolumeDb } from '@/features/timeline/utils/audio-volume'
import { getVisibleTrackIds } from '@/features/timeline/utils/group-utils'
import { getMagnetTrackId } from '@/features/timeline/utils/magnet-track'
import { canLinkSelection, hasLinkedItems } from '@/features/timeline/utils/linked-items'
import {
  insertFreezeFrame,
  linkItems,
  splitAllItemsAtFrame,
  trimItemEnd,
  trimItemStart,
  unlinkItems,
} from '../../stores/actions/item-actions'
import type { TransformProperties } from '@/types/transform'
import type { TimelineShortcutCallbacks } from '../use-timeline-shortcuts'
import { useClearKeyframesDialogStore } from '@/shared/state/clear-keyframes-dialog'
import { useResolvedHotkeys, useUiMotionProfile } from '@/features/timeline/deps/settings'
import { useKeyframeSelectionStore } from '../../stores/keyframe-selection-store'

export function useEditingShortcuts(callbacks: TimelineShortcutCallbacks) {
  const hotkeys = useResolvedHotkeys()
  const mainTrackMagnet = useUiMotionProfile().mainTrackMagnet
  const selectedItemIds = useSelectionStore((s) => s.selectedItemIds)
  const selectedMarkerId = useSelectionStore((s) => s.selectedMarkerId)
  const selectedTransitionId = useSelectionStore((s) => s.selectedTransitionId)
  const editKeyframePanelOpen = useSelectionStore((s) => s.editKeyframePanelOpen)
  const clearSelection = useSelectionStore((s) => s.clearSelection)
  const selectItems = useSelectionStore((s) => s.selectItems)
  const selectedKeyframes = useKeyframeSelectionStore((s) => s.selectedKeyframes)
  const removeItems = useTimelineStore((s) => s.removeItems)
  const removeMarker = useTimelineStore((s) => s.removeMarker)
  const removeTransition = useTimelineStore((s) => s.removeTransition)
  const rippleDeleteItems = useTimelineStore((s) => s.rippleDeleteItems)
  const updateItemsTransformMap = useTimelineStore((s) => s.updateItemsTransformMap)
  const joinItems = useTimelineStore((s) => s.joinItems)
  const items = useTimelineStore((s) => s.items)
  const keyframeEditorShortcutScopeActive = useEditorStore(
    (s) => s.keyframeEditorShortcutScopeActive,
  )
  const transcriptEditorShortcutScopeActive = useEditorStore(
    (s) => s.transcriptEditorShortcutScopeActive,
  )
  const toggleLinkedSelectionEnabled = useEditorStore((s) => s.toggleLinkedSelectionEnabled)
  // Another panel (keyframe or transcript editor) owns Delete/Backspace — clip
  // delete must yield so it doesn't also fire and remove the timeline clip.
  const deleteOwnedByPanel =
    keyframeEditorShortcutScopeActive ||
    (editKeyframePanelOpen && selectedKeyframes.length > 0) ||
    transcriptEditorShortcutScopeActive

  const nudgeSelectedVisualItems = useCallback(
    (deltaX: number, deltaY: number) => {
      if (selectedItemIds.length === 0) return
      if (deltaX === 0 && deltaY === 0) return

      const transforms = new Map<string, Partial<TransformProperties>>()
      for (const itemId of selectedItemIds) {
        const item = items.find((entry) => entry.id === itemId)
        if (!item || item.type === 'audio') continue
        const defaultTransform: Partial<TransformProperties> = item.transform ?? { x: 0, y: 0 }
        const nextX = Math.round((defaultTransform.x ?? 0) + deltaX)
        const nextY = Math.round((defaultTransform.y ?? 0) + deltaY)

        transforms.set(itemId, {
          ...defaultTransform,
          x: nextX,
          y: nextY,
        })
      }

      if (transforms.size === 0) return
      updateItemsTransformMap(transforms, { operation: 'move' })
    },
    [selectedItemIds, items, updateItemsTransformMap],
  )

  // With the main track magnet on, deleting a clip that lives on it closes the
  // gap behind it — the CapCut behaviour. Anything else deletes in place.
  const deleteSelectedItems = useCallback(() => {
    if (selectedItemIds.length === 0) return

    const { items: currentItems, tracks } = useTimelineStore.getState()
    const magnetTrackId = mainTrackMagnet ? getMagnetTrackId(tracks) : null
    const allOnMagnetTrack =
      magnetTrackId !== null &&
      selectedItemIds.every(
        (id) => currentItems.find((entry) => entry.id === id)?.trackId === magnetTrackId,
      )

    if (allOnMagnetTrack) {
      rippleDeleteItems(selectedItemIds)
    } else {
      removeItems(selectedItemIds)
    }
    callbacks.onDelete?.()
  }, [callbacks, mainTrackMagnet, removeItems, rippleDeleteItems, selectedItemIds])

  // Editing: Delete - Delete selected items, marker, or transition
  useHotkeys(
    hotkeys.DELETE_SELECTED,
    (event) => {
      if (deleteOwnedByPanel) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (selectedTransitionId) {
        event.preventDefault()
        removeTransition(selectedTransitionId)
        clearSelection()
        return
      }
      if (selectedMarkerId) {
        event.preventDefault()
        removeMarker(selectedMarkerId)
        clearSelection()
        return
      }
      if (selectedItemIds.length > 0) {
        event.preventDefault()
        deleteSelectedItems()
      }
    },
    HOTKEY_OPTIONS,
    [
      deleteOwnedByPanel,
      deleteSelectedItems,
      selectedItemIds,
      selectedMarkerId,
      selectedTransitionId,
      removeMarker,
      removeTransition,
      clearSelection,
    ],
  )

  // Editing: Backspace - Delete selected items, marker, or transition (alternative)
  useHotkeys(
    hotkeys.DELETE_SELECTED_ALT,
    (event) => {
      if (deleteOwnedByPanel) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (selectedTransitionId) {
        event.preventDefault()
        removeTransition(selectedTransitionId)
        clearSelection()
        return
      }
      if (selectedMarkerId) {
        event.preventDefault()
        removeMarker(selectedMarkerId)
        clearSelection()
        return
      }
      if (selectedItemIds.length > 0) {
        event.preventDefault()
        deleteSelectedItems()
      }
    },
    HOTKEY_OPTIONS,
    [
      deleteOwnedByPanel,
      deleteSelectedItems,
      selectedItemIds,
      selectedMarkerId,
      selectedTransitionId,
      removeMarker,
      removeTransition,
      clearSelection,
    ],
  )

  // Editing: Ctrl+Delete - Ripple delete selected items (delete + close gap)
  useHotkeys(
    hotkeys.RIPPLE_DELETE,
    (event) => {
      if (deleteOwnedByPanel) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (selectedItemIds.length > 0) {
        event.preventDefault()
        rippleDeleteItems(selectedItemIds)
        clearSelection()
        if (callbacks.onDelete) {
          callbacks.onDelete()
        }
      }
    },
    HOTKEY_OPTIONS,
    [deleteOwnedByPanel, selectedItemIds, rippleDeleteItems, clearSelection, callbacks],
  )

  // Editing: Ctrl+Backspace - Ripple delete selected items (alternative)
  useHotkeys(
    hotkeys.RIPPLE_DELETE_ALT,
    (event) => {
      if (deleteOwnedByPanel) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (selectedItemIds.length > 0) {
        event.preventDefault()
        rippleDeleteItems(selectedItemIds)
        clearSelection()
        if (callbacks.onDelete) {
          callbacks.onDelete()
        }
      }
    },
    HOTKEY_OPTIONS,
    [deleteOwnedByPanel, selectedItemIds, rippleDeleteItems, clearSelection, callbacks],
  )

  // Editing: Shift+Arrow keys - nudge selected visual items by 1px
  useHotkeys(
    hotkeys.NUDGE_LEFT,
    (event) => {
      event.preventDefault()
      nudgeSelectedVisualItems(-1, 0)
    },
    HOTKEY_OPTIONS,
    [nudgeSelectedVisualItems],
  )

  useHotkeys(
    hotkeys.NUDGE_RIGHT,
    (event) => {
      event.preventDefault()
      nudgeSelectedVisualItems(1, 0)
    },
    HOTKEY_OPTIONS,
    [nudgeSelectedVisualItems],
  )

  useHotkeys(
    hotkeys.NUDGE_UP,
    (event) => {
      event.preventDefault()
      nudgeSelectedVisualItems(0, -1)
    },
    HOTKEY_OPTIONS,
    [nudgeSelectedVisualItems],
  )

  useHotkeys(
    hotkeys.NUDGE_DOWN,
    (event) => {
      event.preventDefault()
      nudgeSelectedVisualItems(0, 1)
    },
    HOTKEY_OPTIONS,
    [nudgeSelectedVisualItems],
  )

  // Editing: Cmd/Ctrl+Shift+Arrow keys - nudge selected visual items by 10px
  useHotkeys(
    hotkeys.NUDGE_LEFT_LARGE,
    (event) => {
      event.preventDefault()
      nudgeSelectedVisualItems(-10, 0)
    },
    HOTKEY_OPTIONS,
    [nudgeSelectedVisualItems],
  )

  useHotkeys(
    hotkeys.NUDGE_RIGHT_LARGE,
    (event) => {
      event.preventDefault()
      nudgeSelectedVisualItems(10, 0)
    },
    HOTKEY_OPTIONS,
    [nudgeSelectedVisualItems],
  )

  useHotkeys(
    hotkeys.NUDGE_UP_LARGE,
    (event) => {
      event.preventDefault()
      nudgeSelectedVisualItems(0, -10)
    },
    HOTKEY_OPTIONS,
    [nudgeSelectedVisualItems],
  )

  useHotkeys(
    hotkeys.NUDGE_DOWN_LARGE,
    (event) => {
      event.preventDefault()
      nudgeSelectedVisualItems(0, 10)
    },
    HOTKEY_OPTIONS,
    [nudgeSelectedVisualItems],
  )

  // Editing: Shift+J - Join selected clips
  useHotkeys(
    hotkeys.JOIN_ITEMS,
    (event) => {
      if (selectedItemIds.length < 2) return

      const selectedItems = selectedItemIds
        .map((id) => items.find((i) => i.id === id))
        .filter((item): item is NonNullable<typeof item> => item !== undefined)

      if (selectedItems.length < 2) return

      if (canJoinMultipleItems(selectedItems)) {
        event.preventDefault()
        joinItems(selectedItemIds)
      }
    },
    HOTKEY_OPTIONS,
    [selectedItemIds, items, joinItems],
  )

  useHotkeys(
    hotkeys.LINK_AUDIO_VIDEO,
    (event) => {
      if (selectedItemIds.length < 2) return
      if (!canLinkSelection(items, selectedItemIds)) return

      event.preventDefault()
      linkItems(selectedItemIds)
    },
    HOTKEY_OPTIONS,
    [selectedItemIds, items],
  )

  useHotkeys(
    hotkeys.UNLINK_AUDIO_VIDEO,
    (event) => {
      if (selectedItemIds.length === 0) return
      if (!selectedItemIds.some((id) => hasLinkedItems(items, id))) return

      event.preventDefault()
      unlinkItems(selectedItemIds)
    },
    HOTKEY_OPTIONS,
    [selectedItemIds, items],
  )

  useHotkeys(
    hotkeys.TOGGLE_LINKED_SELECTION,
    (event) => {
      event.preventDefault()
      toggleLinkedSelectionEnabled()
    },
    HOTKEY_OPTIONS,
    [toggleLinkedSelectionEnabled],
  )

  // Q / W in CapCut motion: throw away everything on one side of the playhead
  // inside the clip it is standing in. Acts on the selection, falling back to
  // the clip under the pointer so it also works straight off a hover.
  const deleteBesidePlayhead = useCallback(
    (side: 'left' | 'right') => {
      const { previewFrame, previewItemId, currentFrame } = usePlaybackStore.getState()
      const frame = previewFrame ?? currentFrame
      const { items: currentItems } = useTimelineStore.getState()
      const straddlesPlayhead = (item: (typeof currentItems)[number]) =>
        frame > item.from && frame < item.from + item.durationInFrames

      const selected = currentItems.filter(
        (item) => selectedItemIds.includes(item.id) && straddlesPlayhead(item),
      )
      const hovered = currentItems.find(
        (item) => item.id === previewItemId && straddlesPlayhead(item),
      )
      const targets = selected.length > 0 ? selected : hovered ? [hovered] : []
      if (targets.length === 0) return

      const targetIds = targets.map((item) => item.id)
      for (const item of targets) {
        if (side === 'left') {
          trimItemStart(item.id, frame - item.from, { itemIds: targetIds })
        } else {
          trimItemEnd(item.id, frame - (item.from + item.durationInFrames), { itemIds: targetIds })
        }
      }
    },
    [selectedItemIds],
  )

  useHotkeys(
    hotkeys.DELETE_LEFT_OF_PLAYHEAD,
    (event) => {
      event.preventDefault()
      deleteBesidePlayhead('left')
    },
    HOTKEY_OPTIONS,
    [deleteBesidePlayhead],
  )

  useHotkeys(
    hotkeys.DELETE_RIGHT_OF_PLAYHEAD,
    (event) => {
      event.preventDefault()
      deleteBesidePlayhead('right')
    },
    HOTKEY_OPTIONS,
    [deleteBesidePlayhead],
  )

  // [ and ] sweep the selection sideways from the playhead. A clip the playhead
  // is standing in belongs to both sides, so it joins either sweep whole.
  const selectSideOfPlayhead = useCallback(
    (side: 'left' | 'right') => {
      const { previewFrame, currentFrame } = usePlaybackStore.getState()
      const frame = previewFrame ?? currentFrame
      const { items: currentItems, tracks } = useTimelineStore.getState()
      const visibleTrackIds = getVisibleTrackIds(tracks)
      const lockedTrackIds = new Set(
        tracks.filter((track) => track.locked).map((track) => track.id),
      )

      const swept = currentItems
        .filter((item) => visibleTrackIds.has(item.trackId) && !lockedTrackIds.has(item.trackId))
        .filter((item) =>
          side === 'left' ? item.from < frame : item.from + item.durationInFrames > frame,
        )
        .map((item) => item.id)

      if (swept.length > 0) selectItems(swept)
    },
    [selectItems],
  )

  useHotkeys(
    hotkeys.SELECT_TO_LEFT,
    (event) => {
      event.preventDefault()
      selectSideOfPlayhead('left')
    },
    HOTKEY_OPTIONS,
    [selectSideOfPlayhead],
  )

  useHotkeys(
    hotkeys.SELECT_TO_RIGHT,
    (event) => {
      event.preventDefault()
      selectSideOfPlayhead('right')
    },
    HOTKEY_OPTIONS,
    [selectSideOfPlayhead],
  )

  useHotkeys(
    hotkeys.DESELECT_ALL,
    (event) => {
      event.preventDefault()
      clearSelection()
    },
    HOTKEY_OPTIONS,
    [clearSelection],
  )

  // Ride the volume of every selected audible clip in 0.1 dB steps.
  const nudgeSelectedVolume = useCallback(
    (deltaDb: number) => {
      if (selectedItemIds.length === 0) return
      const { items: currentItems, updateItem } = useTimelineStore.getState()
      for (const itemId of selectedItemIds) {
        const item = currentItems.find((entry) => entry.id === itemId)
        if (!item || (item.type !== 'audio' && item.type !== 'video')) continue
        const next = clampAudioVolumeDb(Math.round(((item.volume ?? 0) + deltaDb) * 10) / 10)
        if (next === (item.volume ?? 0)) continue
        updateItem(itemId, { volume: next })
      }
    },
    [selectedItemIds],
  )

  useHotkeys(
    hotkeys.VOLUME_UP,
    (event) => {
      event.preventDefault()
      nudgeSelectedVolume(0.1)
    },
    HOTKEY_OPTIONS,
    [nudgeSelectedVolume],
  )

  useHotkeys(
    hotkeys.VOLUME_DOWN,
    (event) => {
      event.preventDefault()
      nudgeSelectedVolume(-0.1)
    },
    HOTKEY_OPTIONS,
    [nudgeSelectedVolume],
  )

  const splitAtPlayhead = useCallback((event: KeyboardEvent) => {
    event.preventDefault()
    const { previewFrame, currentFrame } = usePlaybackStore.getState()
    const splitFrame = previewFrame ?? currentFrame
    splitAllItemsAtFrame(splitFrame)
  }, [])

  // Editing: Alt+C - Split all items at gray playhead (or main playhead)
  useHotkeys(
    hotkeys.SPLIT_AT_PLAYHEAD_ALT,
    splitAtPlayhead,
    { ...HOTKEY_OPTIONS, eventListenerOptions: { capture: true } },
    [splitAtPlayhead],
  )

  // Editing: Shift+F - Insert freeze frame at playhead
  useHotkeys(
    hotkeys.FREEZE_FRAME,
    (event) => {
      if (selectedItemIds.length !== 1) return
      const currentFrame = usePlaybackStore.getState().currentFrame
      const selectedItem = items.find((i) => i.id === selectedItemIds[0])
      if (!selectedItem || selectedItem.type !== 'video') return

      // Check playhead is within item bounds
      if (
        currentFrame <= selectedItem.from ||
        currentFrame >= selectedItem.from + selectedItem.durationInFrames
      )
        return

      event.preventDefault()
      void insertFreezeFrame(selectedItem.id, currentFrame)
    },
    HOTKEY_OPTIONS,
    [selectedItemIds, items],
  )

  // Keyframes: Shift+A - Clear all keyframes for selected items (with confirmation)
  useHotkeys(
    hotkeys.CLEAR_KEYFRAMES,
    (event) => {
      if (selectedItemIds.length === 0) return

      event.preventDefault()

      const storeKeyframes = useTimelineStore.getState().keyframes
      const itemsWithKeyframes = selectedItemIds.filter((itemId) => {
        const itemKeyframes = storeKeyframes.find((k) => k.itemId === itemId)
        return itemKeyframes?.properties.some((p) => p.keyframes.length > 0)
      })

      if (itemsWithKeyframes.length === 0) return

      useClearKeyframesDialogStore.getState().openClearAll(itemsWithKeyframes)
    },
    HOTKEY_OPTIONS,
    [selectedItemIds],
  )
}

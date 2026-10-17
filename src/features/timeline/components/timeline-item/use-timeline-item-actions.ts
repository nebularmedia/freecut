import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { i18n } from '@/i18n'
import type { TimelineItem as TimelineItemType } from '@/types/timeline'
import type { AnimatableProperty } from '@/types/keyframe'
import type { MediaTranscriptModel, MediaTranscriptQuantization } from '@/types/storage'
import { useSelectionStore } from '@/shared/state/selection'
import { usePlaybackStore } from '@/shared/state/playback'
import { useClearKeyframesDialogStore } from '@/shared/state/clear-keyframes-dialog'
import { useTtsGenerateDialogStore } from '@/shared/state/tts-generate-dialog'
import { getTextItemPlainText } from '@/shared/utils/text-item-spans'
import {
  isTranscriptionOutOfMemoryError,
  TRANSCRIPTION_OOM_HINT,
} from '@/shared/utils/transcription-cancellation'
import { useMediaLibraryStore } from '@/features/timeline/deps/media-library-store'
import {
  getMediaTranscriptionModelLabel,
  mediaTranscriptionService,
  runMediaTranscriptionJob,
} from '@/features/timeline/deps/media-transcription-service'
import { useTimelineStore } from '../../stores/timeline-store'
import { useItemsStore } from '../../stores/items-store'
import {
  insertFreezeFrame,
  linkItems,
  reverseItems,
  splitItemAtFrames,
  unlinkItems,
  updateItem,
} from '../../stores/actions/item-actions'
import { importMediaLibraryService } from '../../deps/media-library-service'
import {
  createPreComp,
  dissolvePreComp,
  openComposition,
} from '../../stores/actions/composition-actions'
import {
  type TimelineItemOverlay,
  useTimelineItemOverlayStore,
} from '../../stores/timeline-item-overlay-store'
import { useSilenceRemovalDialogStore } from '../../stores/silence-removal-dialog-store'
import { useFillerRemovalDialogStore } from '../../stores/filler-removal-dialog-store'
import { canJoinMultipleItems } from '../../utils/clip-utils'
import { canLinkSelection, hasLinkedItems } from '../../utils/linked-items'
import {
  getSceneVerificationModelLabel,
  importSceneDetection,
  SCENE_DETECTOR_VERSION,
  type SceneDetectionMethod,
  type VerificationModel,
} from '../../deps/analysis'
import { resolveMediaUrl } from '../../deps/media-library-resolver'
import {
  stabilizeService,
  STRENGTH_CROP_RATIO,
  type StabilizeStrength,
} from '../../deps/media-library-stabilize'
import { getItemSourceSpanSeconds } from '../../utils/media-item-frames'
import { useBentoLayoutDialogStore } from '../bento-layout-dialog-store'
import { createLogger } from '@/shared/logging/logger'
import { saveScenes } from '@/infrastructure/storage/workspace-fs/scenes'
import {
  analyzeFillerWordsForItems,
  applyFillerPreviewOverlays,
  DEFAULT_FILLER_REMOVAL_SETTINGS,
} from '../../utils/filler-word-removal-preview'
import { mapSceneCutTimesToTimelineFrames } from '../../utils/scene-cut-frames'

const logger = createLogger('UseTimelineItemActions')

const SCENE_DETECTION_OVERLAY_ID = 'scene-detection'
const STABILIZE_OVERLAY_ID = 'stabilize'

interface SelectionCapabilities {
  canJoin: boolean
  canLink: boolean
  canUnlink: boolean
}

let cachedSelectionIds: string[] | null = null
let cachedSelectionItems: TimelineItemType[] | null = null
let cachedSelectionCapabilities: SelectionCapabilities = {
  canJoin: false,
  canLink: false,
  canUnlink: false,
}

/**
 * Context-menu capabilities are selection-wide, but every mounted clip renders
 * its own menu trigger. Cache the shared calculation by the stable Zustand
 * array references so a multi-select drag does the work once instead of once
 * per selected clip on both drag start and drag end.
 */
function getSelectionCapabilities(): SelectionCapabilities {
  const selectedItemIds = useSelectionStore.getState().selectedItemIds
  const itemsState = useItemsStore.getState()
  const items = itemsState.items

  if (selectedItemIds === cachedSelectionIds && items === cachedSelectionItems) {
    return cachedSelectionCapabilities
  }

  const selectedItems = selectedItemIds
    .map((id) => itemsState.itemById[id])
    .filter((candidate): candidate is TimelineItemType => candidate !== undefined)

  cachedSelectionIds = selectedItemIds
  cachedSelectionItems = items
  cachedSelectionCapabilities = {
    canJoin: selectedItems.length >= 2 && canJoinMultipleItems(selectedItems),
    canLink: selectedItemIds.length >= 2 && canLinkSelection(items, selectedItemIds),
    canUnlink:
      selectedItemIds.length > 0 && selectedItemIds.some((id) => hasLinkedItems(items, id)),
  }

  return cachedSelectionCapabilities
}

interface UseTimelineItemActionsParams {
  item: TimelineItemType
  isBroken: boolean
  leftNeighbor: TimelineItemType | null
  rightNeighbor: TimelineItemType | null
  segmentOverlays: readonly TimelineItemOverlay[]
}

export function useTimelineItemActions({
  item,
  isBroken,
  leftNeighbor,
  rightNeighbor,
  segmentOverlays,
}: UseTimelineItemActionsParams) {
  const getCanJoinSelected = useCallback(() => getSelectionCapabilities().canJoin, [])

  const getCanLinkSelected = useCallback(() => getSelectionCapabilities().canLink, [])

  const getCanUnlinkSelected = useCallback(() => getSelectionCapabilities().canUnlink, [])

  const handleJoinSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length >= 2) {
      const itemById = useItemsStore.getState().itemById
      const selectedItems = selectedItemIds
        .map((id) => itemById[id])
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
      if (canJoinMultipleItems(selectedItems)) {
        useTimelineStore.getState().joinItems(selectedItemIds)
      }
    }
  }, [])

  const handleJoinLeft = useCallback(() => {
    if (leftNeighbor) {
      useTimelineStore.getState().joinItems([leftNeighbor.id, item.id])
    }
  }, [leftNeighbor, item.id])

  const handleJoinRight = useCallback(() => {
    if (rightNeighbor) {
      useTimelineStore.getState().joinItems([item.id, rightNeighbor.id])
    }
  }, [rightNeighbor, item.id])

  const handleDelete = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length > 0) {
      useTimelineStore.getState().removeItems(selectedItemIds)
    }
  }, [])

  const handleRippleDelete = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length > 0) {
      useTimelineStore.getState().rippleDeleteItems(selectedItemIds)
    }
  }, [])

  const handleLinkSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    void linkItems(selectedItemIds)
  }, [])

  const handleUnlinkSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    unlinkItems(selectedItemIds)
  }, [])

  const handleReverseSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    reverseItems(selectedItemIds.length > 0 ? selectedItemIds : [item.id])
  }, [item.id])

  const handleClearAllKeyframes = useCallback(() => {
    useClearKeyframesDialogStore.getState().openClearAll([item.id])
  }, [item.id])

  const handleClearPropertyKeyframes = useCallback(
    (property: AnimatableProperty) => {
      useClearKeyframesDialogStore.getState().openClearProperty([item.id], property)
    },
    [item.id],
  )

  const handleBentoLayout = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length < 2) {
      return
    }
    useBentoLayoutDialogStore.getState().open(selectedItemIds)
  }, [])

  const handleFreezeFrame = useCallback(() => {
    if (item.type !== 'video') {
      return
    }
    const { currentFrame } = usePlaybackStore.getState()
    void insertFreezeFrame(item.id, currentFrame)
  }, [item.id, item.type])

  const textContent = item.type === 'text' ? getTextItemPlainText(item) : ''
  const hasSpeakableText = textContent.trim().length > 0

  const handleGenerateAudioFromText = useCallback(() => {
    if (!hasSpeakableText) {
      return
    }
    useTtsGenerateDialogStore.getState().open(textContent, item.id)
  }, [hasSpeakableText, item.id, textContent])

  const handleCaptionGeneration = useCallback(
    (
      model: MediaTranscriptModel,
      options?: {
        forceTranscription?: boolean
        replaceExisting?: boolean
        quantization?: MediaTranscriptQuantization
        language?: string
        onError?: (error: unknown) => void
      },
    ) => {
      if ((item.type !== 'video' && item.type !== 'audio') || !item.mediaId || isBroken) {
        return
      }

      const mediaId = item.mediaId
      const clipId = item.id
      const store = useMediaLibraryStore.getState()
      const forceTranscription = options?.forceTranscription ?? false
      const replaceExisting = options?.replaceExisting ?? false

      const run = async () => {
        try {
          const existingTranscript = await mediaTranscriptionService.getTranscript(mediaId)
          const needsTranscription =
            forceTranscription || !existingTranscript || existingTranscript.model !== model

          if (needsTranscription) {
            const result = await runMediaTranscriptionJob(mediaId, {
              model,
              quantization: options?.quantization,
              language: options?.language || undefined,
            })
            if (result.status === 'cancelled') {
              return
            }
          } else {
            store.setTranscriptStatus(mediaId, 'ready')
            store.clearTranscriptProgress(mediaId)
          }
          const result = await mediaTranscriptionService.enableTranscriptCaptions(mediaId, {
            clipIds: [clipId],
            replaceExisting,
          })

          const modelLabel = getMediaTranscriptionModelLabel(model)
          const successMessage = replaceExisting
            ? result.updatedClipCount > 0
              ? result.removedItemCount > 0
                ? i18n.t('timeline.captions.updatedWithModel', { model: modelLabel })
                : i18n.t('timeline.captions.refreshedWithModel', { model: modelLabel })
              : i18n.t('timeline.captions.removedFromSegment')
            : i18n.t('timeline.captions.addedWithModel', { model: modelLabel })

          store.showNotification({
            type: 'success',
            message: successMessage,
          })
        } catch (error) {
          const fallbackMessage =
            error instanceof Error
              ? error.message
              : i18n.t('timeline.captions.failedGenerateSegment')
          const friendlyMessage = isTranscriptionOutOfMemoryError(error)
            ? TRANSCRIPTION_OOM_HINT
            : fallbackMessage
          options?.onError?.(error)
          store.showNotification({
            type: 'error',
            message: friendlyMessage,
          })
        }
      }

      // Start directly rather than via requestAnimationFrame: rAF is suspended while the
      // tab is hidden/occluded, which would leave caption generation hung until the tab
      // regained focus. Transcription runs in workers, so there's no paint to wait for.
      void run()
    },
    [item.id, item.mediaId, item.type, isBroken],
  )

  const handleCaptionsFromDialog = useCallback(
    (
      values: {
        model: MediaTranscriptModel
        quantization: MediaTranscriptQuantization
        language: string
      },
      hasExistingCaptions: boolean,
      onError?: (error: unknown) => void,
    ) => {
      handleCaptionGeneration(values.model, {
        // The dialog path is always "generate fresh captions". Existing
        // transcripts are auto-enabled as virtual captions when clips load.
        forceTranscription: true,
        replaceExisting: hasExistingCaptions,
        quantization: values.quantization,
        language: values.language,
        onError,
      })
    },
    [handleCaptionGeneration],
  )

  const isSceneDetectionActive = segmentOverlays.some(
    (overlay) => overlay.id === SCENE_DETECTION_OVERLAY_ID,
  )

  // Stabilization progress is published by the media-library store, keyed by whatever id the job
  // was filed under — the clip's, for jobs started here. Mirroring it into the clip's overlay puts
  // the bar on the thing the user is waiting for rather than on a library card they may not have
  // open.
  const stabilizeStatus = useMediaLibraryStore((s) => s.stabilizeStatus.get(item.id))
  const stabilizeProgress = useMediaLibraryStore((s) => s.stabilizeProgress.get(item.id))
  const stabilizeStage = useMediaLibraryStore((s) => s.stabilizeStage.get(item.id))
  const isStabilizing = stabilizeStatus === 'generating'

  useEffect(() => {
    const overlayStore = useTimelineItemOverlayStore.getState()
    if (!isStabilizing) {
      overlayStore.removeOverlay(item.id, STABILIZE_OVERLAY_ID)
      return
    }
    // The two passes are separately paced, so each reports its own 0..1 rather than pretending to
    // be halves of one bar that would stall at 50%.
    overlayStore.upsertOverlay(item.id, {
      id: STABILIZE_OVERLAY_ID,
      label:
        stabilizeStage === 'rendering'
          ? i18n.t('timeline.stabilize.rendering')
          : i18n.t('timeline.stabilize.analyzing'),
      progress: stabilizeProgress ?? 0,
      tone: 'info',
    })
  }, [item.id, isStabilizing, stabilizeStage, stabilizeProgress])

  const isCompositionItem =
    item.type === 'composition' || (item.type === 'audio' && !!item.compositionId)
  const sourceStart = 'sourceStart' in item ? item.sourceStart : undefined
  const clipFrom = item.from

  const handleCreatePreComp = useCallback(() => {
    // Capture selection synchronously - context menu close may clear it before the dynamic import resolves.
    const ids = useSelectionStore.getState().selectedItemIds
    createPreComp(undefined, ids)
  }, [])

  const compositionId = item.compositionId
  const itemLabel = item.label
  const handleEnterComposition = useCallback(() => {
    if (!isCompositionItem || !compositionId) {
      return
    }

    openComposition(compositionId, itemLabel, item.id)
  }, [isCompositionItem, compositionId, itemLabel, item.id])

  const handleDissolveComposition = useCallback(() => {
    if (!isCompositionItem) {
      return
    }

    dissolvePreComp(item.id)
  }, [isCompositionItem, item.id])

  const sceneDetectionAbortRef = useRef<AbortController | null>(null)
  const [isRemovingFillers, setIsRemovingFillers] = useState(false)

  useEffect(() => {
    return () => {
      sceneDetectionAbortRef.current?.abort()
    }
  }, [])

  /**
   * Stabilize just this clip.
   *
   * The render covers the clip's own source span, not the whole file. That is both the cheap
   * reading and the correct one: the camera path is smoothed over exactly the frames that play, so
   * the start of the clip is treated as the start of a shot rather than as the middle of a move
   * that began before the cut.
   *
   * The result comes back as a new library item and this clip is repointed at it, keeping its
   * position, length, speed, transform and effects. Other clips cut from the same source are left
   * alone — stabilization is a decision about one shot.
   */
  const handleStabilizeClip = useCallback(
    (strength: StabilizeStrength) => {
      if (item.type !== 'video' || !item.mediaId || isBroken) return

      const clipId = item.id
      const mediaId = item.mediaId
      const libraryState = useMediaLibraryStore.getState()
      const projectId = libraryState.currentProjectId
      const media = libraryState.mediaById[mediaId]
      if (!projectId || !media) return
      // Progress is keyed by the clip, so two clips from one source can run independently.
      if (stabilizeService.isGenerating(clipId)) return

      const timelineFps = useTimelineStore.getState().fps
      const span = getItemSourceSpanSeconds(item, timelineFps)
      if (!span || span.end <= span.start) return

      stabilizeService.generate({
        mediaId: clipId,
        projectId,
        fileName: media.fileName,
        source:
          media.storageType === 'opfs' && media.opfsPath
            ? { kind: 'opfs', path: media.opfsPath, mimeType: media.mimeType }
            : async () => {
                const { mediaLibraryService } = await importMediaLibraryService()
                return mediaLibraryService.getMediaFile(mediaId)
              },
        sourceFps: media.fps,
        cropRatio: STRENGTH_CROP_RATIO[strength],
        range: { startSeconds: span.start, endSeconds: span.end },
        onImported: (stabilized) => {
          void (async () => {
            try {
              // The clip can be deleted while the render runs. The stabilized media stays in the
              // library either way — it is a real render the user paid for — but there is nothing
              // left to repoint.
              if (!useItemsStore.getState().itemById[clipId]) return
              // `src` is an ephemeral blob URL — it has to be re-resolved for the live session,
              // while `mediaId` is what survives a reload.
              const src = await resolveMediaUrl(stabilized.id)
              const sourceFps = stabilized.fps > 0 ? stabilized.fps : timelineFps
              const sourceFrames = Math.max(1, Math.round(stabilized.duration * sourceFps))

              updateItem(clipId, {
                mediaId: stabilized.id,
                src,
                // The render already covers only this clip, so the new source starts where the
                // clip starts and the trim collapses to nothing.
                sourceStart: 0,
                sourceEnd: sourceFrames,
                sourceDuration: sourceFrames,
                sourceFps,
                trimStart: 0,
                trimEnd: 0,
                thumbnailUrl: undefined,
                // Every reverse conform describes ranges of the old source and is now a lie.
                reverseConformSrc: undefined,
                reverseConformPath: undefined,
                reverseConformKey: undefined,
                reverseConformPreviewSrc: undefined,
                reverseConformPreviewPath: undefined,
                reverseConformPreviewKey: undefined,
                reverseConformStatus: undefined,
                reverseConformLocalStart: undefined,
              })
              toast.success(i18n.t('timeline.stabilize.toastDone'))
            } catch (error) {
              logger.error('Failed to repoint clip at the stabilized render', { clipId, error })
              toast.error(i18n.t('timeline.stabilize.toastFailed'))
            }
          })()
        },
      })
    },
    [item, isBroken],
  )

  const handleDetectScenes = useCallback(
    (method: SceneDetectionMethod, verificationModel?: VerificationModel) => {
      if (item.type !== 'video' || !item.mediaId || isBroken) {
        return
      }

      const mediaId = item.mediaId
      const clipId = item.id
      const overlayStore = useTimelineItemOverlayStore.getState()

      const run = async () => {
        sceneDetectionAbortRef.current?.abort()
        const abortController = new AbortController()
        sceneDetectionAbortRef.current = abortController
        let video: HTMLVideoElement | null = null

        try {
          overlayStore.upsertOverlay(clipId, {
            id: SCENE_DETECTION_OVERLAY_ID,
            label: i18n.t('timeline.sceneDetection.detectingScenes'),
            progress: 0,
            tone: 'info',
          })

          const url = await resolveMediaUrl(mediaId)
          video = document.createElement('video')
          video.src = url
          video.muted = true
          video.preload = 'auto'

          await new Promise<void>((resolve, reject) => {
            if (abortController.signal.aborted) {
              reject(new DOMException('Aborted', 'AbortError'))
              return
            }
            const onAbort = () => {
              reject(new DOMException('Aborted', 'AbortError'))
            }
            abortController.signal.addEventListener('abort', onAbort, { once: true })
            video!.onloadedmetadata = () => {
              abortController.signal.removeEventListener('abort', onAbort)
              resolve()
            }
            video!.onerror = () => {
              abortController.signal.removeEventListener('abort', onAbort)
              reject(new Error('Failed to load video for scene detection'))
            }
          })

          const currentFps = useTimelineStore.getState().fps
          const media = useMediaLibraryStore.getState().mediaById[mediaId]
          const mediaFps = media?.fps ?? currentFps
          const { detectScenes } = await importSceneDetection()
          const cuts = await detectScenes(video, {
            method,
            verificationModel,
            mediaId,
            sourceFps: mediaFps,
            signal: abortController.signal,
            onProgress: (progress) => {
              const modelLabel = progress.verificationModel
                ? getSceneVerificationModelLabel(progress.verificationModel)
                : 'AI'
              const stageLabels = {
                analyzing: `Analyzing frames (${progress.sceneCuts} candidates)`,
                classifying: `Classifying cuts (${progress.sceneCuts} candidates)`,
                'loading-model': `Loading ${modelLabel} model (${progress.percent.toFixed(0)}%)`,
                verifying: `Verifying cuts (${progress.sceneCuts}/${progress.total} confirmed)`,
              }
              const label = stageLabels[progress.stage]
              useTimelineItemOverlayStore.getState().upsertOverlay(clipId, {
                id: SCENE_DETECTION_OVERLAY_ID,
                label,
                progress: progress.percent,
                tone: 'info',
              })
            },
          })

          // Persist scene cuts to the workspace so the next session/window
          // doesn't need to recompute. Fire-and-forget — UX proceeds regardless.
          if (cuts.length > 0) {
            void saveScenes({
              mediaId,
              service: method === 'histogram' ? 'scene-detect-histogram' : 'scene-detect-adaptive',
              model: verificationModel ?? method,
              method,
              detectorVersion: SCENE_DETECTOR_VERSION,
              sampleIntervalMs: method === 'histogram' ? 250 : undefined,
              verificationModel,
              cuts,
            }).catch((error) => logger.warn('Failed to persist scene cuts', error))
          }

          if (cuts.length === 0) {
            toast.info(i18n.t('timeline.sceneDetection.noScenesDetected'))
            return
          }

          const clipDuration = item.durationInFrames
          // Source trims use native FPS; scene boundaries are persisted as source time.
          const sourceStartSeconds = (sourceStart ?? 0) / mediaFps
          const splitFrames = mapSceneCutTimesToTimelineFrames({
            cuts,
            sourceStartSeconds,
            projectFps: currentFps,
            clipFrom,
            clipDurationInFrames: clipDuration,
          })

          if (splitFrames.length === 0) {
            toast.info(i18n.t('timeline.sceneDetection.noScenesWithinBounds'))
            return
          }

          const splitCount = splitItemAtFrames(clipId, splitFrames)

          if (splitCount > 0) {
            toast.success(i18n.t('timeline.sceneDetection.splitAtScenes', { count: splitCount }))
          } else {
            toast.info(i18n.t('timeline.sceneDetection.noValidSplitPoints'))
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return
          }
          toast.error(i18n.t('timeline.sceneDetection.failed'))
        } finally {
          if (video) {
            video.onloadedmetadata = null
            video.onerror = null
            video.src = ''
          }
          // Only remove overlay if this run still owns the controller
          if (sceneDetectionAbortRef.current === abortController) {
            useTimelineItemOverlayStore.getState().removeOverlay(clipId, SCENE_DETECTION_OVERLAY_ID)
          }
        }
      }

      void run()
    },
    [clipFrom, isBroken, item.durationInFrames, item.id, item.mediaId, item.type, sourceStart],
  )

  const handleRemoveSilence = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    const targetIds = selectedItemIds.length > 0 ? selectedItemIds : [item.id]
    const targetItems = targetIds
      .map((id) => useItemsStore.getState().itemById[id])
      .filter(
        (candidate): candidate is TimelineItemType =>
          candidate !== undefined &&
          (candidate.type === 'video' || candidate.type === 'audio') &&
          !!candidate.mediaId,
      )

    if (targetItems.length === 0) {
      toast.info(i18n.t('timeline.itemActions.selectAvClipFirst'))
      return
    }

    useSilenceRemovalDialogStore.getState().open({
      itemIds: targetItems.map((target) => target.id),
    })
  }, [item.id])

  const handleRemoveFillers = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    const targetIds = selectedItemIds.length > 0 ? selectedItemIds : [item.id]
    const targetItems = targetIds
      .map((id) => useItemsStore.getState().itemById[id])
      .filter(
        (candidate): candidate is TimelineItemType =>
          candidate !== undefined &&
          (candidate.type === 'video' || candidate.type === 'audio') &&
          !!candidate.mediaId,
      )

    if (targetItems.length === 0) {
      toast.info('Select an audio or video clip first')
      return
    }

    const run = async () => {
      setIsRemovingFillers(true)
      try {
        const targetItemIds = targetItems.map((target) => target.id)
        const rangesByMediaId = await analyzeFillerWordsForItems(
          targetItemIds,
          DEFAULT_FILLER_REMOVAL_SETTINGS,
        )
        const summary = applyFillerPreviewOverlays(targetItemIds, rangesByMediaId)

        if (summary.rangeCount === 0) {
          toast.info(i18n.t('timeline.fillerRemoval.noRemovableDetectedShort'))
          return
        }

        useFillerRemovalDialogStore.getState().open({
          itemIds: targetItemIds,
          settings: DEFAULT_FILLER_REMOVAL_SETTINGS,
          rangesByMediaId,
          summary,
        })
      } catch (error) {
        logger.warn('Remove filler words failed', error)
        toast.error(
          error instanceof Error
            ? error.message
            : i18n.t('timeline.fillerRemoval.toastPreviewFailed'),
        )
      } finally {
        setIsRemovingFillers(false)
      }
    }

    void run()
  }, [item.id])

  return {
    getCanJoinSelected,
    getCanLinkSelected,
    getCanUnlinkSelected,
    hasSpeakableText,
    isSceneDetectionActive,
    isStabilizing,
    isRemovingFillers,
    isCompositionItem,
    handleJoinSelected,
    handleJoinLeft,
    handleJoinRight,
    handleDelete,
    handleRippleDelete,
    handleLinkSelected,
    handleUnlinkSelected,
    handleReverseSelected,
    handleClearAllKeyframes,
    handleClearPropertyKeyframes,
    handleBentoLayout,
    handleFreezeFrame,
    handleGenerateAudioFromText,
    handleCaptionsFromDialog,
    handleCreatePreComp,
    handleEnterComposition,
    handleDissolveComposition,
    handleDetectScenes,
    handleStabilizeClip,
    handleRemoveSilence,
    handleRemoveFillers,
  }
}

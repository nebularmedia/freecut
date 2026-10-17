import { useShallow } from 'zustand/react/shallow'
import { getUiMotionProfile, type UiMotionProfile } from '@/config/ui-motion'
import { useSettingsStore } from '../stores/settings-store'

/**
 * The effective motion profile: the active mode's defaults, with the explicit
 * wheel setting layered on top when the user pinned one.
 */
export function useUiMotionProfile(): UiMotionProfile {
  return useSettingsStore(
    useShallow((state) =>
      getUiMotionProfile(state.uiMotionMode, state.timelineWheel, state.mainTrackMagnet),
    ),
  )
}

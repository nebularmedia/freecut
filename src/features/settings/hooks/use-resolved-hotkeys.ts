import { useShallow } from 'zustand/react/shallow'
import { resolveHotkeys } from '@/config/hotkeys'
import { getBaseHotkeys } from '@/config/ui-motion'
import { useSettingsStore } from '../stores/settings-store'

export function useResolvedHotkeys() {
  return useSettingsStore(
    useShallow((state) =>
      resolveHotkeys(state.hotkeyOverrides, getBaseHotkeys(state.uiMotionMode)),
    ),
  )
}

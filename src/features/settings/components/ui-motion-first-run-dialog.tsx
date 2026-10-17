import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useSettingsStore } from '../stores/settings-store'
import { UiMotionModePicker } from './ui-motion-mode-picker'

/**
 * Asked once, on the first launch: which editor's movement should the mouse
 * and the keyboard follow. Picking a card already applies the mode, so the
 * button only closes the card — and picking nothing keeps the default.
 */
export function UiMotionFirstRunDialog() {
  const { t } = useTranslation()
  const uiMotionMode = useSettingsStore((state) => state.uiMotionMode)
  const uiMotionModeChosen = useSettingsStore((state) => state.uiMotionModeChosen)
  const setUiMotionMode = useSettingsStore((state) => state.setUiMotionMode)

  if (uiMotionModeChosen) return null

  const confirm = () => setUiMotionMode(uiMotionMode)

  return (
    <Dialog open onOpenChange={(open) => !open && confirm()}>
      <DialogContent className="max-w-xl" hideCloseButton>
        <DialogHeader>
          <DialogTitle>{t('projects.settings.motion.firstRun.title')}</DialogTitle>
          <DialogDescription>
            {t('projects.settings.motion.firstRun.description')}
          </DialogDescription>
        </DialogHeader>
        <UiMotionModePicker />
        <DialogFooter>
          <Button onClick={confirm}>{t('projects.settings.motion.firstRun.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

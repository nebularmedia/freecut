import { useTranslation } from 'react-i18next'
import { MousePointer2, Scissors } from 'lucide-react'
import { cn } from '@/shared/ui/cn'
import { UI_MOTION_MODES, type TimelineWheelSetting, type UiMotionMode } from '@/config/ui-motion'
import { useSettingsStore } from '../stores/settings-store'

const MODE_ICONS: Record<UiMotionMode, typeof MousePointer2> = {
  freecut: MousePointer2,
  capcut: Scissors,
}

/** The handful of bindings that tell the two layouts apart at a glance. */
const MODE_SAMPLE_KEYS: Record<UiMotionMode, readonly string[]> = {
  freecut: ['Alt + C', 'V / C', 'Ctrl + Del', 'S'],
  capcut: ['Ctrl + B', 'Q / W', 'A / B', 'Shift + Z'],
}

const WHEEL_OPTIONS: readonly TimelineWheelSetting[] = ['auto', 'travel', 'tracks', 'zoom']

interface UiMotionModePickerProps {
  /** `cards` is the first-run choice; `strip` is the inline settings control. */
  variant?: 'cards' | 'strip'
  className?: string
}

export function UiMotionModePicker({ variant = 'cards', className }: UiMotionModePickerProps) {
  const { t } = useTranslation()
  const uiMotionMode = useSettingsStore((state) => state.uiMotionMode)
  const setUiMotionMode = useSettingsStore((state) => state.setUiMotionMode)
  const timelineWheel = useSettingsStore((state) => state.timelineWheel)
  const setSetting = useSettingsStore((state) => state.setSetting)

  if (variant === 'strip') {
    return (
      <div className={cn('flex items-center gap-3', className)}>
        <div className="flex items-center gap-1">
          {UI_MOTION_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={uiMotionMode === mode}
              onClick={() => setUiMotionMode(mode)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 ease-out motion-reduce:transition-none',
                uiMotionMode === mode
                  ? 'border-primary/45 bg-primary/15 text-primary'
                  : 'border-white/8 bg-white/4 text-muted-foreground hover:text-foreground/80',
              )}
            >
              {t(`projects.settings.motion.modes.${mode}.title`)}
            </button>
          ))}
        </div>
        <WheelControl
          value={timelineWheel}
          onChange={(next) => setSetting('timelineWheel', next)}
        />
      </div>
    )
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="grid gap-3 sm:grid-cols-2">
        {UI_MOTION_MODES.map((mode) => {
          const Icon = MODE_ICONS[mode]
          const isActive = uiMotionMode === mode
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={isActive}
              onClick={() => setUiMotionMode(mode)}
              className={cn(
                'flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors duration-150 ease-out motion-reduce:transition-none',
                isActive
                  ? 'border-primary/45 bg-primary/10'
                  : 'border-white/8 bg-white/4 hover:border-white/15',
              )}
            >
              <span className="flex items-center gap-2">
                <Icon
                  className={cn('h-4 w-4', isActive ? 'text-primary' : 'text-muted-foreground')}
                />
                <span className="text-sm font-medium text-foreground">
                  {t(`projects.settings.motion.modes.${mode}.title`)}
                </span>
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {t(`projects.settings.motion.modes.${mode}.description`)}
              </span>
              <span className="flex flex-wrap gap-1 pt-1">
                {MODE_SAMPLE_KEYS[mode].map((sample) => (
                  <kbd
                    key={sample}
                    className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  >
                    {sample}
                  </kbd>
                ))}
              </span>
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <WheelControl
          value={timelineWheel}
          onChange={(next) => setSetting('timelineWheel', next)}
        />
        <span className="text-[11px] text-muted-foreground">
          {t('projects.settings.motion.wheel.hint')}
        </span>
      </div>
    </div>
  )
}

interface WheelControlProps {
  value: TimelineWheelSetting
  onChange: (value: TimelineWheelSetting) => void
}

function WheelControl({ value, onChange }: WheelControlProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {t('projects.settings.motion.wheel.label')}
      </span>
      <div className="flex items-center gap-1">
        {WHEEL_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={cn(
              'rounded-md border px-2 py-0.5 text-[11px] transition-colors duration-150 ease-out motion-reduce:transition-none',
              value === option
                ? 'border-primary/45 bg-primary/15 text-primary'
                : 'border-white/8 bg-white/4 text-muted-foreground hover:text-foreground/80',
            )}
          >
            {t(`projects.settings.motion.wheel.${option}`)}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * UI motion modes — how the editor answers the mouse and the keyboard.
 *
 * `freecut` keeps the NLE muscle memory this editor grew up with (the
 * Premiere / Resolve family). `capcut` re-teaches the same commands the way
 * CapCut does them, for editors arriving from there: Ctrl+B splits, Q/W throw
 * away everything left/right of the playhead, A/B swap select and blade, `~`
 * toggles linkage, Shift+Z fits the timeline, the bare wheel walks the tracks
 * while Alt+wheel travels, and the bottom video track becomes a main track
 * magnet that never holds a gap.
 *
 * A mode only moves the *base* binding of a command. A user override always
 * wins over it, so remapping a key survives switching modes.
 */
import { HOTKEYS, type HotkeyBindingMap, type HotkeyOverrideMap } from './hotkeys'

export const UI_MOTION_MODES = ['freecut', 'capcut'] as const
export type UiMotionMode = (typeof UI_MOTION_MODES)[number]

export const DEFAULT_UI_MOTION_MODE: UiMotionMode = 'capcut'

export function normalizeUiMotionMode(value: unknown): UiMotionMode {
  return UI_MOTION_MODES.includes(value as UiMotionMode)
    ? (value as UiMotionMode)
    : DEFAULT_UI_MOTION_MODE
}

/**
 * What a wheel gesture over the timeline does.
 *
 * `travel` moves along the timeline, `tracks` moves across them, and
 * `track-height` resizes the track rows under the pointer.
 */
export type TimelineWheelGesture = 'zoom' | 'travel' | 'tracks' | 'track-height'

/** What a bare wheel (no modifier) does. */
export type TimelineWheelAction = Exclude<TimelineWheelGesture, 'track-height'>

/** `auto` follows the active motion mode; the others pin the bare wheel. */
export type TimelineWheelSetting = 'auto' | TimelineWheelAction

export function normalizeTimelineWheelSetting(value: unknown): TimelineWheelSetting {
  // 'scroll' is the pre-release name for what is now 'travel'.
  if (value === 'scroll') return 'travel'
  return value === 'travel' || value === 'tracks' || value === 'zoom' ? value : 'auto'
}

export interface UiMotionProfile {
  /** What a bare wheel over the timeline does. */
  timelineWheel: TimelineWheelAction
  /** Which modifier travels along the timeline. */
  travelModifier: 'none' | 'alt' | 'shift'
  /**
   * Where a "walk the tracks" gesture goes when the pointer is not inside a
   * track pane — over the ruler, or in the empty room around the rows.
   *
   * `pointer` does nothing there: the gesture is aimed at a pane, which is
   * fine while it lives on a modifier. `nearest` falls back to the main pane
   * so the gesture works anywhere in the timeline, which it has to when it is
   * the bare wheel, as in CapCut.
   */
  trackScrollFallback: 'pointer' | 'nearest'
  /**
   * How a scroll gesture moves the viewport.
   *
   * `glide` ramps into a velocity and coasts to a stop — the inertial feel
   * this editor shipped with. `step` moves the whole distance inside the
   * wheel event and stops dead, which is what CapCut does: there, how far one
   * notch travels is just the OS "lines to scroll" setting, with no editor-side
   * physics on top of it.
   */
  scrollFeel: 'glide' | 'step'
  /** A plain click on empty track background parks the playhead there. */
  backgroundClickSeeks: boolean
  /**
   * The bottom video track behaves like CapCut's main track: no gaps, and a
   * drop into it inserts and pushes instead of looking for a hole.
   */
  mainTrackMagnet: boolean
  /**
   * Narrowest clip, in pixels, that still shows its thumbnails.
   *
   * Below it the strip is dropped as a level-of-detail measure. CapCut keeps
   * drawing the picture however short the clip is — and short clips are the
   * whole point there — so it wants a floor low enough to never blank one out.
   */
  filmstripMinWidthPx: number
  /** How far the "jump" shortcuts move the playhead, in frames. */
  jumpFrames: number
}

const UI_MOTION_PROFILES: Record<UiMotionMode, UiMotionProfile> = {
  freecut: {
    timelineWheel: 'travel',
    travelModifier: 'none',
    trackScrollFallback: 'pointer',
    scrollFeel: 'glide',
    backgroundClickSeeks: false,
    filmstripMinWidthPx: 20,
    mainTrackMagnet: false,
    jumpFrames: 10,
  },
  capcut: {
    // CapCut's own mapping: bare wheel walks the tracks, Alt+wheel travels
    // along the timeline, Ctrl+wheel zooms.
    timelineWheel: 'tracks',
    travelModifier: 'alt',
    trackScrollFallback: 'nearest',
    scrollFeel: 'step',
    backgroundClickSeeks: true,
    filmstripMinWidthPx: 4,
    mainTrackMagnet: true,
    jumpFrames: 10,
  },
}

export function getUiMotionProfile(
  mode: UiMotionMode,
  wheelSetting: TimelineWheelSetting = 'auto',
  /** null follows the mode; a boolean is the user's own answer. */
  magnetOverride: boolean | null = null,
): UiMotionProfile {
  const profile = UI_MOTION_PROFILES[mode]
  const wheelMatches = wheelSetting === 'auto' || wheelSetting === profile.timelineWheel
  const magnetMatches = magnetOverride === null || magnetOverride === profile.mainTrackMagnet
  if (wheelMatches && magnetMatches) return profile

  return {
    ...profile,
    timelineWheel: wheelMatches ? profile.timelineWheel : (wheelSetting as TimelineWheelAction),
    mainTrackMagnet: magnetMatches ? profile.mainTrackMagnet : (magnetOverride as boolean),
  }
}

export interface TimelineWheelModifiers {
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** The gesture itself is horizontal (trackpad two-finger swipe). */
  horizontal: boolean
}

/**
 * The one place that decides what a wheel event means.
 *
 * Ctrl/Cmd always zooms, and a horizontal gesture always travels — those two
 * are the same in every editor. Everything else comes from the mode: whichever
 * modifier is not spending itself on travel keeps the track-height resize.
 */
export function resolveTimelineWheelGesture(
  profile: UiMotionProfile,
  modifiers: TimelineWheelModifiers,
): TimelineWheelGesture {
  if (modifiers.ctrl) return 'zoom'
  if (modifiers.horizontal) return 'travel'

  if (profile.travelModifier === 'alt') {
    // Track heights move onto Alt+Shift so Alt alone can travel.
    if (modifiers.alt) return modifiers.shift ? 'track-height' : 'travel'
    if (modifiers.shift) return 'travel'
    return profile.timelineWheel
  }

  if (modifiers.alt) return 'track-height'
  if (modifiers.shift) return 'tracks'
  return profile.timelineWheel
}

/**
 * CapCut's own bindings, mapped onto this editor's commands.
 *
 * Only the slots that actually move are listed — anything CapCut already
 * agrees with (Space, arrows, Home/End, I/O, M, N for snap, Ctrl+Z, Ctrl+S,
 * J/K/L shuttle) keeps the FreeCut default. Commands CapCut has no equivalent
 * for are left alone rather than invented.
 */
export const CAPCUT_HOTKEY_OVERRIDES: HotkeyOverrideMap = {
  // Cutting. CapCut splits the clip you are pointing at with Ctrl+B and every
  // track at once with Ctrl+Shift+B.
  SPLIT_AT_CURSOR: 'mod+b',
  SPLIT_AT_PLAYHEAD_ALT: 'mod+shift+b',
  // Q/W eat the tail on either side of the playhead — the CapCut rough-cut rhythm.
  DELETE_LEFT_OF_PLAYHEAD: 'q',
  DELETE_RIGHT_OF_PLAYHEAD: 'w',
  RIPPLE_DELETE: 'mod+shift+d',

  // Sweeping the selection sideways, and dropping it. In/out points give up
  // Alt+X to the deselect they share it with in the FreeCut layout.
  SELECT_TO_LEFT: 'bracketleft',
  SELECT_TO_RIGHT: 'bracketright',
  DESELECT_ALL: 'alt+x',
  CLEAR_IN_OUT: 'mod+alt+x',

  // The main-track magnet, on P as in CapCut.
  TOGGLE_MAIN_TRACK_MAGNET: 'p',

  // Volume rides on Ctrl + comma / period.
  VOLUME_UP: 'mod+period',
  VOLUME_DOWN: 'mod+comma',

  // Tools. A selects, B is the blade; `c` and `s` go quiet, as in CapCut.
  SELECTION_TOOL: 'a',
  RAZOR_TOOL: 'b',

  // Linkage lives on the tilde key.
  TOGGLE_LINKED_SELECTION: 'backquote',

  // Shift+arrows walk the playhead in strides; nudging the picture moves to Alt.
  JUMP_BACKWARD: 'shift+left',
  JUMP_FORWARD: 'shift+right',
  NUDGE_LEFT: 'alt+left',
  NUDGE_RIGHT: 'alt+right',
  NUDGE_UP: 'alt+up',
  NUDGE_DOWN: 'alt+down',

  // Zoom to fit.
  ZOOM_TO_FIT: 'shift+z',

  // Markers: M drops one, Shift+M / Alt+Shift+M walk them.
  NEXT_MARKER: 'shift+m',
  PREVIOUS_MARKER: 'alt+shift+m',
  REMOVE_MARKER: 'alt+m',

  // Keyframes move off the bare K so K stays the shuttle brake.
  EDIT_KEYFRAME_ADD: 'alt+k',
  KEYFRAME_TOGGLE_AUTO: 'shift+k',
}

const UI_MOTION_HOTKEY_PRESETS: Record<UiMotionMode, HotkeyOverrideMap> = {
  freecut: {},
  capcut: CAPCUT_HOTKEY_OVERRIDES,
}

/**
 * The bindings a mode starts from, before the user's own overrides land.
 */
export function getBaseHotkeys(mode: UiMotionMode): HotkeyBindingMap {
  return { ...HOTKEYS, ...UI_MOTION_HOTKEY_PRESETS[mode] }
}

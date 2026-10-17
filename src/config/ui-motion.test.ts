// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import { HOTKEYS, findHotkeyConflicts, resolveHotkeys, type HotkeyKey } from './hotkeys'
import {
  CAPCUT_HOTKEY_OVERRIDES,
  UI_MOTION_MODES,
  getBaseHotkeys,
  getUiMotionProfile,
  normalizeTimelineWheelSetting,
  normalizeUiMotionMode,
  resolveTimelineWheelGesture,
  type TimelineWheelModifiers,
} from './ui-motion'

describe('ui motion modes', () => {
  it('falls back to the CapCut default for unknown values', () => {
    expect(normalizeUiMotionMode('nope')).toBe('capcut')
    expect(normalizeUiMotionMode('freecut')).toBe('freecut')
    expect(normalizeTimelineWheelSetting('nope')).toBe('auto')
    expect(normalizeTimelineWheelSetting('zoom')).toBe('zoom')
  })

  it('leaves every mode free of shortcut collisions', () => {
    for (const mode of UI_MOTION_MODES) {
      const bindings = getBaseHotkeys(mode)
      const collisions = (Object.keys(bindings) as HotkeyKey[]).flatMap((key) =>
        bindings[key] ? findHotkeyConflicts(bindings, bindings[key], key) : [],
      )
      expect({ mode, collisions }).toEqual({ mode, collisions: [] })
    }
  })

  it('only remaps commands this editor actually has', () => {
    for (const key of Object.keys(CAPCUT_HOTKEY_OVERRIDES)) {
      expect(key in HOTKEYS).toBe(true)
    }
  })

  it('gives CapCut the bindings a CapCut editor reaches for', () => {
    const capcut = getBaseHotkeys('capcut')
    expect({
      split: capcut.SPLIT_AT_CURSOR,
      deleteLeft: capcut.DELETE_LEFT_OF_PLAYHEAD,
      deleteRight: capcut.DELETE_RIGHT_OF_PLAYHEAD,
      select: capcut.SELECTION_TOOL,
      blade: capcut.RAZOR_TOOL,
      fit: capcut.ZOOM_TO_FIT,
      snap: capcut.TOGGLE_SNAP,
    }).toEqual({
      split: 'mod+b',
      deleteLeft: 'q',
      deleteRight: 'w',
      select: 'a',
      blade: 'b',
      fit: 'shift+z',
      snap: 'n',
    })
  })

  it('keeps a user override above the mode it was recorded in', () => {
    const bindings = resolveHotkeys({ SELECTION_TOOL: 'v' }, getBaseHotkeys('capcut'))
    expect(bindings.SELECTION_TOOL).toBe('v')
    expect(bindings.RAZOR_TOOL).toBe('b')
  })

  it('pins the wheel only when the user asked for something else', () => {
    expect(getUiMotionProfile('capcut')).toBe(getUiMotionProfile('capcut', 'auto'))
    expect(getUiMotionProfile('capcut', 'travel').timelineWheel).toBe('travel')
    expect(getUiMotionProfile('freecut', 'zoom').timelineWheel).toBe('zoom')
  })

  it('scrolls by inertia in FreeCut motion and by direct steps in CapCut motion', () => {
    expect(getUiMotionProfile('freecut').scrollFeel).toBe('glide')
    expect(getUiMotionProfile('capcut').scrollFeel).toBe('step')
  })

  it('only lets the tracks gesture fall back to a pane when it is the bare wheel', () => {
    expect(getUiMotionProfile('freecut').trackScrollFallback).toBe('pointer')
    expect(getUiMotionProfile('capcut').trackScrollFallback).toBe('nearest')
  })

  it('lets CapCut motion keep thumbnails on far narrower clips', () => {
    expect(getUiMotionProfile('freecut').filmstripMinWidthPx).toBe(20)
    expect(getUiMotionProfile('capcut').filmstripMinWidthPx).toBe(4)
  })

  it('reads a wheel gesture the way each mode does', () => {
    const freecut = getUiMotionProfile('freecut')
    const capcut = getUiMotionProfile('capcut')
    const gesture = (profile: typeof freecut, modifiers: Partial<TimelineWheelModifiers>) =>
      resolveTimelineWheelGesture(profile, {
        ctrl: false,
        alt: false,
        shift: false,
        horizontal: false,
        ...modifiers,
      })

    // Ctrl zooms and a horizontal swipe travels, whatever the mode.
    expect(gesture(freecut, { ctrl: true })).toBe('zoom')
    expect(gesture(capcut, { ctrl: true })).toBe('zoom')
    expect(gesture(capcut, { horizontal: true })).toBe('travel')

    // FreeCut: bare wheel travels, Shift walks the tracks, Alt resizes them.
    expect(gesture(freecut, {})).toBe('travel')
    expect(gesture(freecut, { shift: true })).toBe('tracks')
    expect(gesture(freecut, { alt: true })).toBe('track-height')

    // CapCut: bare wheel walks the tracks, Alt travels, Alt+Shift resizes.
    expect(gesture(capcut, {})).toBe('tracks')
    expect(gesture(capcut, { alt: true })).toBe('travel')
    expect(gesture(capcut, { shift: true })).toBe('travel')
    expect(gesture(capcut, { alt: true, shift: true })).toBe('track-height')
  })
})

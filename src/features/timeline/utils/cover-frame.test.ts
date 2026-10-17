import { describe, expect, it } from 'vitest'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'
import { resolveCoverFrame } from './cover-frame'

const track = (id: string, visible = true): TimelineTrack => ({
  id,
  name: id,
  kind: 'video',
  height: 100,
  locked: false,
  visible,
  muted: false,
  solo: false,
  order: 0,
  items: [],
})

const picture = (
  id: string,
  from: number,
  durationInFrames: number,
  trackId = 'v1',
): TimelineItem =>
  ({
    id,
    type: 'image',
    trackId,
    from,
    durationInFrames,
    label: id,
    src: '',
  }) as TimelineItem

const title = (id: string, from: number, durationInFrames: number, trackId = 'v1'): TimelineItem =>
  ({
    id,
    type: 'text',
    trackId,
    from,
    durationInFrames,
    label: id,
    text: id,
    color: '#fff',
  }) as TimelineItem

describe('resolveCoverFrame', () => {
  it('lands half a second into the opening picture, clear of the fade', () => {
    expect(resolveCoverFrame([picture('a', 0, 105)], [track('v1')], 30)).toBe(15)
  })

  it('follows the opening picture when the montage does not start at zero', () => {
    expect(resolveCoverFrame([picture('a', 90, 105)], [track('v1')], 30)).toBe(105)
  })

  it('stays inside a very short opening clip', () => {
    expect(resolveCoverFrame([picture('a', 0, 8)], [track('v1')], 30)).toBe(4)
  })

  it('prefers the picture over a title that starts earlier', () => {
    const items = [title('t', 0, 60, 'v2'), picture('a', 30, 120)]
    expect(resolveCoverFrame(items, [track('v1'), track('v2')], 30)).toBe(45)
  })

  it('falls back to the opening item when there is no picture at all', () => {
    expect(resolveCoverFrame([title('t', 60, 90)], [track('v1')], 30)).toBe(75)
  })

  it('ignores items on hidden tracks', () => {
    const items = [picture('hidden', 0, 120, 'v2'), picture('shown', 60, 120)]
    expect(resolveCoverFrame(items, [track('v1'), track('v2', false)], 30)).toBe(75)
  })

  it('scales the settle time with the project fps', () => {
    expect(resolveCoverFrame([picture('a', 0, 300)], [track('v1')], 60)).toBe(30)
  })

  it('returns frame zero for an empty timeline', () => {
    expect(resolveCoverFrame([], [track('v1')], 30)).toBe(0)
  })

  it('is stable when two items open on the same frame', () => {
    const items = [picture('b', 0, 90), picture('a', 0, 90, 'v2')]
    expect(resolveCoverFrame(items, [track('v1'), track('v2')], 30)).toBe(15)
  })
})

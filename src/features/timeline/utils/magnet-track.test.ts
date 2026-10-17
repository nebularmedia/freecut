// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'
import { getMagnetTrackId, planMagnetPlacement } from './magnet-track'

function track(id: string, order: number, kind: 'video' | 'audio' = 'video'): TimelineTrack {
  return {
    id,
    name: id,
    kind,
    order,
    height: 80,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    items: [],
  }
}

function clip(id: string, trackId: string, from: number, duration: number): TimelineItem {
  return {
    id,
    type: 'video',
    trackId,
    from,
    durationInFrames: duration,
    label: id,
    src: `${id}.mp4`,
  }
}

describe('getMagnetTrackId', () => {
  it('picks the lowest video track, ignoring audio and group rows', () => {
    const tracks = [
      track('A1', 0, 'audio'),
      { ...track('G', 1), isGroup: true },
      track('V2', 3),
      track('V1', 2),
    ]

    expect(getMagnetTrackId(tracks)).toBe('V1')
  })

  it('reports nothing when there is no video track', () => {
    expect(getMagnetTrackId([track('A1', 0, 'audio')])).toBeNull()
  })
})

describe('planMagnetPlacement', () => {
  const items = [clip('a', 'V1', 0, 30), clip('b', 'V1', 30, 30), clip('c', 'V1', 60, 30)]

  it('closes gaps without reordering when the drop stays put', () => {
    const gapped = [clip('a', 'V1', 0, 30), clip('b', 'V1', 50, 30)]
    const placement = planMagnetPlacement({
      items: gapped,
      trackId: 'V1',
      movedItemId: 'b',
      dropFrame: 50,
    })

    expect(placement?.movedFrom).toBe(30)
    expect(placement?.updates).toEqual([{ id: 'b', from: 30 }])
  })

  it('swaps two clips once the drop passes the neighbour midpoint', () => {
    const placement = planMagnetPlacement({
      items,
      trackId: 'V1',
      movedItemId: 'c',
      dropFrame: 10,
    })

    expect(placement?.movedFrom).toBe(0)
    expect(placement?.updates).toEqual([
      { id: 'c', from: 0 },
      { id: 'a', from: 30 },
      { id: 'b', from: 60 },
    ])
  })

  it('inserts a clip arriving from another track and pushes the rest', () => {
    const arriving = [...items, clip('d', 'V2', 40, 20)]
    const placement = planMagnetPlacement({
      items: arriving,
      trackId: 'V1',
      movedItemId: 'd',
      dropFrame: 35,
    })

    expect(placement?.movedFrom).toBe(30)
    expect(placement?.updates).toEqual([
      { id: 'd', from: 30, trackId: 'V1' },
      { id: 'b', from: 50 },
      { id: 'c', from: 80 },
    ])
  })

  it('carries a linked audio companion by the same shift', () => {
    const linked: TimelineItem[] = [
      { ...clip('a', 'V1', 0, 30), linkedGroupId: 'pair' },
      { ...clip('a-audio', 'A1', 0, 30), type: 'audio', linkedGroupId: 'pair' } as TimelineItem,
      clip('b', 'V1', 30, 30),
    ]

    const placement = planMagnetPlacement({
      items: linked,
      trackId: 'V1',
      movedItemId: 'b',
      dropFrame: 0,
    })

    expect(placement?.updates).toEqual([
      { id: 'b', from: 0 },
      { id: 'a', from: 30 },
      { id: 'a-audio', from: 30 },
    ])
  })
})

// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { MediaMetadata } from '@/types/storage'
import { isHeavyForPreview, megapixelsPerSecond } from './heavy-media'

function media(over: Partial<MediaMetadata>): MediaMetadata {
  return {
    id: 'm1',
    storageType: 'workspace',
    fileName: 'clip.mp4',
    fileSize: 1_000_000,
    mimeType: 'video/mp4',
    duration: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    bitrate: 0,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as MediaMetadata
}

describe('megapixelsPerSecond', () => {
  it('multiplies the three dimensions of the load', () => {
    expect(megapixelsPerSecond({ width: 1920, height: 1080, fps: 30 })).toBe(62.2)
    expect(megapixelsPerSecond({ width: 3840, height: 2160, fps: 30 })).toBe(248.8)
  })

  it('reads a still as no load rather than as an unknown', () => {
    expect(megapixelsPerSecond({ width: 4000, height: 3000, fps: 0 })).toBe(0)
  })
})

describe('isHeavyForPreview', () => {
  it('leaves alone what the GPU decodes without breaking a sweat', () => {
    // 1080p30 and even 1080p60 H.264 play fine on a decade-old machine.
    expect(isHeavyForPreview(media({})).heavy).toBe(false)
    expect(isHeavyForPreview(media({ fps: 60 })).heavy).toBe(false)
  })

  it('catches 4K30, which is the same load as 1080p60 four times over', () => {
    const v = isHeavyForPreview(media({ width: 3840, height: 2160 }))
    expect(v.heavy).toBe(true)
    expect(v.reason).toBe('throughput')
  })

  it('catches vertical VP9 at 60, which is the Instagram reel case', () => {
    const v = isHeavyForPreview(media({ width: 1080, height: 1920, fps: 60, codec: 'vp9' }))
    expect(v.heavy).toBe(true)
    expect(v.reason).toBe('software-codec')
    expect(v.megapixelsPerSecond).toBe(124.4)
  })

  it('holds a software codec to a lower budget than a hardware one', () => {
    // Identical clip, and only the codec decides.
    const dims = { width: 1920, height: 1080, fps: 30 }
    expect(isHeavyForPreview(media({ ...dims, codec: 'vp9' })).heavy).toBe(true)
    expect(isHeavyForPreview(media({ ...dims, codec: 'h264' })).heavy).toBe(false)
  })

  it('reads the long codec strings, not just the short names', () => {
    expect(isHeavyForPreview(media({ codec: 'av01.0.05M.08', fps: 60 })).heavy).toBe(true)
    expect(isHeavyForPreview(media({ codec: 'avc1.640028', fps: 60 })).heavy).toBe(false)
  })

  it('does not leave a small software-decoded clip transcoding for nothing', () => {
    expect(
      isHeavyForPreview(media({ width: 1280, height: 720, fps: 30, codec: 'vp9' })).heavy,
    ).toBe(false)
  })

  it('always proxies what the browser cannot decode, however small', () => {
    const v = isHeavyForPreview(
      media({ width: 640, height: 480, fps: 24, codec: 'prores', videoCodecSupported: false }),
    )
    expect(v.heavy).toBe(true)
    expect(v.reason).toBe('undecodable')
  })

  it('never touches anything that is not video', () => {
    expect(isHeavyForPreview(media({ mimeType: 'image/jpeg', fps: 0 })).heavy).toBe(false)
    expect(isHeavyForPreview(media({ mimeType: 'audio/wav', width: 0, height: 0 })).heavy).toBe(
      false,
    )
  })
})

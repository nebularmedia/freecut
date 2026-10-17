import type { MediaMetadata } from '@/types/storage'

/**
 * Which media are too heavy to preview from the original, and should get a
 * proxy without anyone asking for one.
 *
 * WHY THIS EXISTS
 * The proxy machinery was already here — a 960x540 transcode, a queue, a
 * status badge — but all three ways to start it were buttons. So the editor
 * stuttered until someone knew to go and press one, and knowing that is not
 * something a user should have to learn from the frame rate.
 *
 * WHAT "HEAVY" MEANS, AND WHY IT IS NOT JUST RESOLUTION
 * The cost of previewing a clip is roughly **pixels per second** — width x
 * height x fps — not pixel count. 1080x1920@60 and 4K@30 are both about a
 * quarter of a gigapixel a second, and both hurt; the same 1080x1920 at 24 fps
 * is fine. Judging by resolution alone would proxy the second one for nothing
 * and miss the first.
 *
 * And the same pixel costs very different amounts depending on the codec.
 * H.264 and HEVC go through the GPU's decoder on essentially every machine
 * shipped this decade. VP9, VP8 and AV1 frequently do not — support depends on
 * the GPU, the driver and the browser build — so they land on the CPU, in
 * software, where they cost several times more. That is why they get their own,
 * much lower threshold instead of a single number for everything.
 *
 * This is deliberately a heuristic over metadata we already captured at import.
 * Measuring real decode throughput would be more accurate and would mean
 * decoding the file to find out whether decoding it is too slow.
 */

/**
 * Codecs a browser often has to decode in software. Matched as substrings
 * because the field carries anything from `vp9` to `av01.0.05M.08`.
 */
const SOFTWARE_DECODED = ['vp9', 'vp09', 'vp8', 'vp08', 'av1', 'av01']

/**
 * Megapixels per second above which a SOFTWARE-decoded clip gets a proxy.
 * 60 puts 1080p30 VP9 (62,2) just over and leaves 720p30 VP9 (27,6) alone.
 */
const SOFTWARE_BUDGET_MPX_S = 60

/**
 * The same for codecs the GPU almost certainly handles. 140 catches 4K30
 * (249) and 1440p60 (221) while leaving 1080p60 H.264 (124) alone, which
 * plays fine on hardware that is a decade old.
 */
const HARDWARE_BUDGET_MPX_S = 140

export type HeavyMediaReason = 'undecodable' | 'software-codec' | 'throughput'

export interface HeavyMediaVerdict {
  heavy: boolean
  reason?: HeavyMediaReason
  /** Megapixels per second, rounded to one decimal. For the log line and the tooltip. */
  megapixelsPerSecond: number
}

function isSoftwareDecoded(codec: string): boolean {
  const c = codec.toLowerCase()
  return SOFTWARE_DECODED.some((needle) => c.includes(needle))
}

/**
 * Megapixels per second this clip asks the decoder for.
 *
 * `fps` is 0 for images and can be missing on a malformed probe; treating that
 * as 0 throughput is the safe direction — it means "do not proxy", and the
 * cost of not proxying is a slow preview, while the cost of proxying
 * everything is transcoding a library nobody asked to transcode.
 */
export function megapixelsPerSecond(
  media: Pick<MediaMetadata, 'width' | 'height' | 'fps'>,
): number {
  const { width, height, fps } = media
  if (!width || !height || !fps) return 0
  return Math.round(((width * height * fps) / 1_000_000) * 10) / 10
}

/**
 * Should this media get a proxy generated for it without being asked?
 *
 * Only ever true for video. Images and audio have no decode cost worth
 * transcoding away, and `canGenerateProxy` would refuse them anyway.
 */
export function isHeavyForPreview(media: MediaMetadata): HeavyMediaVerdict {
  const mpxs = megapixelsPerSecond(media)
  if (!media.mimeType?.startsWith('video/')) return { heavy: false, megapixelsPerSecond: mpxs }

  // Nothing to weigh up: without a proxy this clip cannot be shown at all.
  // ProRes is the case that put this branch here.
  if (media.videoCodecSupported === false) {
    return { heavy: true, reason: 'undecodable', megapixelsPerSecond: mpxs }
  }

  const budget = isSoftwareDecoded(media.codec ?? '')
    ? SOFTWARE_BUDGET_MPX_S
    : HARDWARE_BUDGET_MPX_S
  if (mpxs < budget) return { heavy: false, megapixelsPerSecond: mpxs }

  return {
    heavy: true,
    reason: budget === SOFTWARE_BUDGET_MPX_S ? 'software-codec' : 'throughput',
    megapixelsPerSecond: mpxs,
  }
}

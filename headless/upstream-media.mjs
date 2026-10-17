// Stream a media source that lives on another host through this local origin.
//
// Why proxy instead of handing the page the remote URL directly: the harness
// runs cross-origin-isolated (COEP: require-corp), so it can only read a
// cross-origin subresource that opts in — and media hosts rarely do both halves
// of what a renderer needs. Measured on one such host (2026-08-13): the light
// proxy answered `Range` with 206 but sent no CORS header, and the originals
// endpoint sent `access-control-allow-origin: *` but ignored `Range` and handed
// over the whole 65 MB file. Relaying fixes both at once — the page sees a
// same-origin URL, and the byte range it asks for is the byte range we ask
// upstream, so mediabunny's UrlSource keeps streaming instead of buffering.
//
// The URL always comes from a workspace descriptor (media/{id}/source.link.json)
// written by whoever runs the render, never from a request.
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { assertUpstreamMediaUrl, HttpError } from './lib/http-security.mjs'

const MAX_REDIRECTS = 3
const SINGLE_BYTE_RANGE = /^bytes=\d*-\d*$/

/** Follow redirects ourselves so every hop passes the same URL check. */
async function fetchUpstream(url, { headers, signal, fetchImpl }) {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current, { headers, signal, redirect: 'manual' })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    response.body?.cancel().catch(() => {})
    if (!location) {
      throw new HttpError(502, 'UPSTREAM_MEDIA_FAILED', 'upstream redirect without a location')
    }
    current = assertUpstreamMediaUrl(new URL(location, current).toString(), 'redirected media url')
  }
  throw new HttpError(502, 'UPSTREAM_MEDIA_FAILED', 'too many upstream redirects')
}

/**
 * Relay one media request to `source.url`, passing the client's Range through.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ url: string, mimeType?: string }} source
 * @param {{ fetchImpl?: typeof fetch, headersTimeoutMs?: number }} [options]
 */
export async function serveUpstreamMedia(
  req,
  res,
  source,
  { fetchImpl = fetch, headersTimeoutMs = 30_000 } = {},
) {
  const url = assertUpstreamMediaUrl(source.url, 'media link url')
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once('aborted', abort)
  res.once('close', abort)
  // The timeout covers reaching the upstream, NOT the transfer: a 4K original
  // legitimately takes minutes to stream and must not be cut off mid-body.
  const timer = setTimeout(abort, headersTimeoutMs)

  const range = req.headers.range
  const headers = { accept: '*/*' }
  if (typeof range === 'string' && SINGLE_BYTE_RANGE.test(range)) headers.range = range

  try {
    let response
    try {
      // Always GET: hosts that serve media are reliable on GET and erratic on
      // HEAD. For a client HEAD we drop the body below instead.
      response = await fetchUpstream(url, { headers, signal: controller.signal, fetchImpl })
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'UPSTREAM_MEDIA_FAILED', `upstream fetch failed: ${error.message}`)
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 416) {
      response.body?.cancel().catch(() => {})
      res.writeHead(416, { 'Content-Range': response.headers.get('content-range') ?? 'bytes */*' })
      res.end()
      return
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {})
      throw new HttpError(502, 'UPSTREAM_MEDIA_FAILED', `upstream responded ${response.status}`)
    }

    const outHeaders = {
      'Content-Type': source.mimeType ?? response.headers.get('content-type') ?? 'video/mp4',
      // Say `bytes` even when the upstream stayed quiet about it: a host that
      // returns 206 to our Range supports it whatever its headers claim.
      'Accept-Ranges':
        response.status === 206 ? 'bytes' : (response.headers.get('accept-ranges') ?? 'none'),
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength) outHeaders['Content-Length'] = contentLength
    const contentRange = response.headers.get('content-range')
    if (contentRange) outHeaders['Content-Range'] = contentRange
    res.writeHead(response.status, outHeaders)

    if (req.method === 'HEAD' || !response.body) {
      response.body?.cancel().catch(() => {})
      res.end()
      return
    }
    try {
      await pipeline(Readable.fromWeb(response.body), res)
    } catch (error) {
      if (!req.aborted && !res.destroyed) throw error
    }
  } finally {
    clearTimeout(timer)
    req.off('aborted', abort)
    res.off('close', abort)
  }
}

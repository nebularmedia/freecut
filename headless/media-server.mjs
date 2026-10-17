// Tiny static media server for headless rendering.
//
// Serves media files by id with CORS + Cross-Origin-Resource-Policy headers so
// the harness page (which runs under COEP: require-corp) can fetch them
// cross-origin, plus HTTP Range support for partial reads.
import http from 'node:http'
import path from 'node:path'
import {
  assertSinglePathComponent,
  decodeRequestPath,
  HttpError,
  requireGetOrHead,
  sendHttpError,
  serveFile,
  setHttpTimeouts,
} from './lib/http-security.mjs'
import { MEDIA_QUALITIES, normalizeMediaSource } from './lib/workspace.mjs'
import { serveUpstreamMedia } from './upstream-media.mjs'

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * `?quality=proxy` on a media URL: which copy of the source to serve. The
 * quality rides on the URL rather than on server state because one warm server
 * serves many render jobs, and two of them may want different copies.
 */
export function requestedMediaQuality(req) {
  const query = (req.url ?? '').split('?')[1]
  const value = query ? new URLSearchParams(query).get('quality') : null
  if (value === null) return undefined
  if (!MEDIA_QUALITIES.includes(value))
    throw new HttpError(400, 'INVALID_MEDIA_QUALITY', 'unknown media quality')
  return value
}

/** The media URL for an id, carrying the quality the resolver should honour. */
export function mediaUrlWith(base, mediaId, quality) {
  const suffix = quality ? `?quality=${encodeURIComponent(quality)}` : ''
  return `${base}/media/${encodeURIComponent(mediaId)}${suffix}`
}

/**
 * @param {Map<string,string> | ((mediaId: string, quality?: string) => string | object | null)} mediaFilesOrResolver
 *   A mediaId->path Map, or a resolver returning an absolute path or a source
 *   descriptor (see resolveMediaSource in lib/workspace.mjs).
 * @param {number} [port]  0 = ephemeral
 * @returns {Promise<{ base: string, url: (id: string, quality?: string) => string, close: () => Promise<void> }>}
 */
export async function createMediaServer(mediaFilesOrResolver, port = 0) {
  const resolveMedia =
    typeof mediaFilesOrResolver === 'function'
      ? mediaFilesOrResolver
      : (mediaId) => mediaFilesOrResolver.get(mediaId) ?? null
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader('Access-Control-Allow-Headers', 'range')
    res.setHeader('Access-Control-Expose-Headers', 'content-range, accept-ranges, content-length')

    try {
      if (!requireGetOrHead(req, res)) return
      const pathname = decodeRequestPath(req)
      const match = pathname.match(/^\/media\/(.+)$/)
      if (!match) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const mediaId = assertSinglePathComponent(match[1], 'media id')
      const source = normalizeMediaSource(resolveMedia(mediaId, requestedMediaQuality(req)))
      if (!source) {
        res.writeHead(404)
        res.end('media not found')
        return
      }
      if (source.kind === 'link') {
        await serveUpstreamMedia(req, res, source)
        return
      }
      await serveFile(req, res, source.path, {
        contentType: MIME[path.extname(source.path).toLowerCase()] ?? 'application/octet-stream',
        allowRange: true,
      })
    } catch (error) {
      sendHttpError(res, error)
    }
  })
  setHttpTimeouts(server)

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const actualPort = server.address().port
  const base = `http://127.0.0.1:${actualPort}`

  return {
    base,
    url: (mediaId, quality) => mediaUrlWith(base, mediaId, quality),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

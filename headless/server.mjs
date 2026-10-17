// Standalone harness server for headless rendering — no Vite dev server needed.
//
// Serves the built harness (`dist/`) AND media from a single localhost origin
// with the cross-origin-isolation headers the harness needs (COEP/COOP), plus
// HTTP Range for media so large clips stream via mediabunny's UrlSource.
import http from 'node:http'
import path from 'node:path'
import {
  assertSinglePathComponent,
  decodeRequestPath,
  requireGetOrHead,
  resolveContained,
  sendHttpError,
  serveFile,
  setHttpTimeouts,
} from './lib/http-security.mjs'
import { mediaUrlWith, requestedMediaQuality } from './media-server.mjs'
import { normalizeMediaSource } from './lib/workspace.mjs'
import { serveUpstreamMedia } from './upstream-media.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  // media
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * @param {{ distDir: string, resolveMedia?: (mediaId: string, quality?: string) => string | object | null, port?: number }} opts
 *   resolveMedia maps a media id to an absolute source-file path, or to a source
 *   descriptor (see resolveMediaSource in lib/workspace.mjs) which may point at
 *   another host. Omit to serve no media (e.g. edit-only).
 * @returns {Promise<{ base: string, harnessUrl: string, mediaUrl: (id: string, quality?: string) => string, close: () => Promise<void> }>}
 */
export async function createHarnessServer({ distDir, resolveMedia = () => null, port = 0 }) {
  const resolvedDist = path.resolve(distDir)

  const server = http.createServer(async (req, res) => {
    // Cross-origin isolation for the harness page (matches the Vite dev server).
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')

    try {
      if (!requireGetOrHead(req, res)) return
      const pathname = decodeRequestPath(req)

      if (pathname === '/favicon.ico') {
        res.writeHead(204)
        res.end()
        return
      }

      const mediaMatch = pathname.match(/^\/media\/(.+)$/)
      if (mediaMatch) {
        const mediaId = assertSinglePathComponent(mediaMatch[1], 'media id')
        const source = normalizeMediaSource(resolveMedia(mediaId, requestedMediaQuality(req)))
        if (!source) {
          res.writeHead(404)
          res.end('media not found')
          return
        }
        if (source.kind === 'link') {
          // Same origin as the harness, so the page's cross-origin isolation
          // never enters into it — see upstream-media.mjs.
          await serveUpstreamMedia(req, res, source)
          return
        }
        await serveFile(req, res, source.path, {
          contentType: contentType(source.path),
          allowRange: true,
        })
        return
      }

      let rel = pathname
      if (rel === '/') rel = '/headless.html'
      rel = rel.replace(/^[/\\]+/, '')
      const filePath = resolveContained(resolvedDist, rel)
      await serveFile(req, res, filePath, { contentType: contentType(filePath), allowRange: false })
    } catch (error) {
      sendHttpError(res, error)
    }
  })
  setHttpTimeouts(server)

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  return {
    base,
    harnessUrl: `${base}/headless.html`,
    mediaUrl: (mediaId, quality) => mediaUrlWith(base, mediaId, quality),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

// Media that lives on another host: the descriptor, which copy gets picked,
// and the relay that lets a cross-origin-isolated page read it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMediaServer } from './media-server.mjs'
import { resolveProjectMedia } from './lib/render-core.mjs'
import { readMediaLink, resolveMediaSource } from './lib/workspace.mjs'

const UPSTREAM_BODY = Buffer.from('0123456789abcdefghij')

function workspaceWith(mediaId, descriptor, { withFile = false } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'freecut-media-link-')))
  const dir = path.join(root, 'media', mediaId)
  fs.mkdirSync(dir, { recursive: true })
  if (descriptor)
    fs.writeFileSync(path.join(dir, 'source.link.json'), JSON.stringify(descriptor, null, 2))
  if (withFile) fs.writeFileSync(path.join(dir, 'local.mp4'), UPSTREAM_BODY)
  return root
}

/** A stand-in for the media host: serves one file, honours a single byte range. */
async function startUpstream({ acceptRanges = true } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range })
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/preview.mp4' })
      res.end()
      return
    }
    const range = acceptRanges ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '') : null
    if (!range) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': UPSTREAM_BODY.length })
      res.end(UPSTREAM_BODY)
      return
    }
    const start = Number(range[1])
    const end = range[2] ? Number(range[2]) : UPSTREAM_BODY.length - 1
    const slice = UPSTREAM_BODY.subarray(start, end + 1)
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': slice.length,
      'Content-Range': `bytes ${start}-${end}/${UPSTREAM_BODY.length}`,
    })
    res.end(slice)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function get(base, requestPath, headers) {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: requestPath, headers },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('a link descriptor is read, and a non-https source is refused', () => {
  const root = workspaceWith('linked', {
    version: '1.0',
    fileName: 'P1019715.MP4',
    mimeType: 'video/mp4',
    sources: {
      original: 'https://example.test/original.mp4',
      proxy: 'https://example.test/preview.mp4',
    },
  })
  try {
    const link = readMediaLink(root, 'linked')
    assert.equal(link.fileName, 'P1019715.MP4')
    assert.equal(link.sources.proxy, 'https://example.test/preview.mp4')
    assert.equal(readMediaLink(root, 'absent'), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  const bad = workspaceWith('linked', {
    sources: { original: 'http://example.test/original.mp4' },
  })
  try {
    assert.throws(
      () => readMediaLink(bad, 'linked'),
      (error) => error.code === 'INVALID_MEDIA_LINK',
    )
  } finally {
    fs.rmSync(bad, { recursive: true, force: true })
  }
})

test('quality picks the copy, and a local file always counts as the original', () => {
  const sources = {
    original: 'https://example.test/original.mp4',
    proxy: 'https://example.test/preview.mp4',
  }
  const linked = workspaceWith('linked', { sources })
  const both = workspaceWith('linked', { sources }, { withFile: true })
  const proxyOnly = workspaceWith('linked', { sources: { proxy: sources.proxy } })
  try {
    assert.equal(resolveMediaSource(linked, 'linked').url, sources.original)
    assert.equal(resolveMediaSource(linked, 'linked', { quality: 'proxy' }).url, sources.proxy)

    // A file on disk beats the linked original, and still loses to a proxy that
    // was asked for by name — that is the whole point of asking.
    assert.equal(resolveMediaSource(both, 'linked').kind, 'file')
    assert.equal(resolveMediaSource(both, 'linked', { quality: 'proxy' }).url, sources.proxy)

    // Asking for the original when only a proxy exists gets the proxy, and says so.
    assert.equal(resolveMediaSource(proxyOnly, 'linked').quality, 'proxy')
    assert.equal(resolveMediaSource(linked, 'absent'), null)
  } finally {
    for (const root of [linked, both, proxyOnly]) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the media server relays a linked source and passes the range through', async () => {
  const upstream = await startUpstream()
  const root = workspaceWith('linked', {
    mimeType: 'video/mp4',
    sources: {
      original: `${upstream.base}/original.mp4`,
      proxy: `${upstream.base}/preview.mp4`,
    },
  })
  const server = await createMediaServer((id, quality) => resolveMediaSource(root, id, { quality }))
  try {
    const ranged = await get(server.base, '/media/linked?quality=proxy', { Range: 'bytes=2-5' })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.body.toString(), '2345')
    assert.equal(ranged.headers['content-range'], `bytes 2-5/${UPSTREAM_BODY.length}`)
    assert.equal(ranged.headers['content-type'], 'video/mp4')
    assert.equal(ranged.headers['accept-ranges'], 'bytes')
    assert.equal(upstream.requests.at(-1).url, '/preview.mp4')
    assert.equal(upstream.requests.at(-1).range, 'bytes=2-5')

    const whole = await get(server.base, '/media/linked')
    assert.equal(whole.status, 200)
    assert.equal(whole.body.toString(), UPSTREAM_BODY.toString())
    assert.equal(upstream.requests.at(-1).url, '/original.mp4')

    const unknownQuality = await get(server.base, '/media/linked?quality=potato')
    assert.equal(unknownQuality.status, 400)

    const redirected = await createMediaServer(() => ({
      kind: 'link',
      quality: 'original',
      url: `${upstream.base}/redirect`,
    }))
    try {
      const followed = await get(redirected.base, '/media/linked')
      assert.equal(followed.status, 200)
      assert.equal(upstream.requests.at(-1).url, '/preview.mp4')
    } finally {
      await redirected.close()
    }
  } finally {
    await server.close()
    await upstream.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an upstream that fails is a 502, not a silent empty clip', async () => {
  const upstream = await startUpstream()
  await upstream.close()
  const server = await createMediaServer(() => ({
    kind: 'link',
    quality: 'original',
    url: `${upstream.base}/gone.mp4`,
  }))
  try {
    assert.equal((await get(server.base, '/media/linked')).status, 502)
  } finally {
    await server.close()
  }
})

test('a linked media counts as resolved, and a proxied one is reported', () => {
  const root = workspaceWith('linked', {
    sources: {
      original: 'https://example.test/original.mp4',
      proxy: 'https://example.test/preview.mp4',
    },
  })
  const project = {
    timeline: { items: [{ type: 'video', mediaId: 'linked', from: 0, durationInFrames: 30 }] },
  }
  try {
    const urlOf = (id, quality) => `http://127.0.0.1:1/media/${id}?quality=${quality}`

    const original = resolveProjectMedia(root, project, urlOf, null)
    assert.deepEqual(original.missing, [])
    assert.deepEqual(original.proxied, [])
    assert.equal(original.mediaResolved, 1)

    const proxy = resolveProjectMedia(root, project, urlOf, null, { quality: 'proxy' })
    assert.deepEqual(proxy.proxied, ['linked'])
    assert.equal(proxy.media[0].url, 'http://127.0.0.1:1/media/linked?quality=proxy')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// Read a FreeCut workspace folder from disk (plain fs, no File System Access
// API). Locates a project's JSON and maps the media it references to source
// files on disk, mirroring workspace-fs's `media/{id}/{filename}` layout.
import fs from 'node:fs'
import path from 'node:path'
import {
  assertSinglePathComponent,
  assertUpstreamMediaUrl,
  HttpError,
  resolveContained,
} from './http-security.mjs'

// Files in media/{id}/ that are NOT the source blob (mirrors
// NON_SOURCE_NAMES in workspace-fs/media-source.ts).
const LINK_FILE_NAME = 'source.link.json'
const NON_SOURCE_NAMES = new Set([
  'metadata.json',
  'thumbnail.jpg',
  'thumbnail.meta.json',
  LINK_FILE_NAME,
  'cache',
])

/** Which copy of a source to render from: the full-res one or the light one. */
export const MEDIA_QUALITIES = ['original', 'proxy']

const MEDIA_ITEM_TYPES = new Set(['video', 'audio', 'image'])

function readProject(projectJsonPath) {
  if (!fs.existsSync(projectJsonPath)) {
    throw new Error(`Project file not found: ${projectJsonPath}`)
  }
  const project = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'))
  return { project, projectJsonPath }
}

/** CLI-only direct file loader. Direct paths must never be accepted by the HTTP service. */
export function loadProjectFile(projectFile) {
  return readProject(path.resolve(projectFile))
}

/** Workspace-scoped loader for HTTP/API project ids. */
export function loadProjectById(workspaceDir, projectId) {
  assertSinglePathComponent(projectId, 'project id')
  const projectsDir = path.join(workspaceDir, 'projects')
  const projectJsonPath = resolveContained(projectsDir, path.join(projectId, 'project.json'))
  if (!fs.existsSync(projectJsonPath))
    throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')
  return readProject(projectJsonPath)
}

/** Backward-compatible CLI loader: id under workspace or an explicit JSON file. */
export function loadProject(workspaceDir, projectIdOrFile) {
  return projectIdOrFile.endsWith('.json')
    ? loadProjectFile(projectIdOrFile)
    : loadProjectById(workspaceDir, projectIdOrFile)
}

/** List projects using the actionable directory name as id; projectId is the JSON's internal id. */
export function listProjects(workspaceDir) {
  const projectsDir = path.join(workspaceDir, 'projects')
  if (!fs.existsSync(projectsDir)) return []
  const out = []
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const jsonPath = path.join(projectsDir, entry.name, 'project.json')
    if (!fs.existsSync(jsonPath)) continue
    try {
      const p = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      out.push({
        id: entry.name,
        projectId: p.id ?? entry.name,
        name: p.name ?? '(unnamed)',
        updatedAt: p.updatedAt ?? 0,
      })
    } catch {
      // skip unreadable project
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Collect media ids referenced by the project's timeline.
 *
 * When `range` ({ inFrame, outFrame } in project frames) is given, only media
 * for top-level items overlapping the range is collected — and for a
 * composition (compound clip) item that overlaps, all media inside its
 * sub-composition. This avoids fetching media that a sliced render never
 * touches (e.g. a multi-hour clip far outside the range).
 */
export function collectMediaIds(project, range = null) {
  const timeline = project.timeline
  if (!timeline) return []

  const ids = new Set()
  const compsById = new Map((timeline.compositions ?? []).map((c) => [c.id, c]))

  const overlaps = (item) => {
    if (!range) return true
    const start = item.from ?? 0
    const end = start + (item.durationInFrames ?? 0)
    const lo = range.inFrame ?? 0
    const hi = range.outFrame ?? Number.POSITIVE_INFINITY
    return end > lo && start < hi
  }

  // Recurse into a sub-composition, collecting its media and following nested
  // composition items (compound clips can reference other compound clips).
  const expandComp = (compId, visited) => {
    if (!compId || visited.has(compId)) return
    visited.add(compId)
    const comp = compsById.get(compId)
    for (const sub of comp?.items ?? []) {
      if (sub.mediaId && MEDIA_ITEM_TYPES.has(sub.type)) ids.add(sub.mediaId)
      if (sub.type === 'composition' && sub.compositionId) expandComp(sub.compositionId, visited)
    }
  }

  for (const item of timeline.items ?? []) {
    if (!overlaps(item)) continue
    if (item.mediaId && MEDIA_ITEM_TYPES.has(item.type)) ids.add(item.mediaId)
    if (item.type === 'composition' && item.compositionId) {
      expandComp(item.compositionId, new Set())
    }
  }
  return [...ids]
}

/** Read a media's MediaMetadata (media/{id}/metadata.json), or null if absent/unreadable. */
export function readMediaMetadata(workspaceDir, mediaId) {
  assertSinglePathComponent(mediaId, 'media id')
  const metaPath = resolveContained(
    path.join(workspaceDir, 'media'),
    path.join(mediaId, 'metadata.json'),
  )
  if (!fs.existsSync(metaPath)) return null
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch {
    return null
  }
}

/** Collect `{ mediaId, metadata }` for media referenced by addClip ops (deduped). */
export function collectAddClipMedia(workspaceDir, ops) {
  const ids = [...new Set(ops.filter((o) => o.op === 'addClip' && o.mediaId).map((o) => o.mediaId))]
  return ids.map((mediaId) => ({
    mediaId,
    metadata: readMediaMetadata(workspaceDir, mediaId) ?? undefined,
  }))
}

/** Resolve a media id to its source file path under media/{id}/ (first non-reserved file). */
export function resolveMediaFile(workspaceDir, mediaId) {
  assertSinglePathComponent(mediaId, 'media id')
  const mediaRoot = path.join(workspaceDir, 'media')
  const mediaDir = resolveContained(mediaRoot, mediaId)
  if (!fs.existsSync(mediaDir)) return null
  for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (NON_SOURCE_NAMES.has(entry.name)) continue
    return resolveContained(mediaRoot, path.join(mediaId, entry.name))
  }
  return null
}

/**
 * Read `media/{id}/source.link.json`: a media whose bytes were never copied
 * into the workspace and live on another host.
 *
 * `sources.original` is the full-res file and `sources.proxy` the light one;
 * both are optional and at least one is required. Nothing else in the workspace
 * changes — the media still has its own `metadata.json`, so the timeline reads
 * the same duration, fps and dimensions whichever copy is rendered.
 *
 * @returns {{ fileName?: string, mimeType?: string, sources: Record<string,string> } | null}
 */
export function readMediaLink(workspaceDir, mediaId) {
  assertSinglePathComponent(mediaId, 'media id')
  const linkPath = resolveContained(
    path.join(workspaceDir, 'media'),
    path.join(mediaId, LINK_FILE_NAME),
  )
  if (!fs.existsSync(linkPath)) return null
  let value
  try {
    value = JSON.parse(fs.readFileSync(linkPath, 'utf8'))
  } catch {
    throw new HttpError(422, 'INVALID_MEDIA_LINK', `${LINK_FILE_NAME} is not readable JSON`)
  }
  const sources = {}
  for (const quality of MEDIA_QUALITIES) {
    const raw = value?.sources?.[quality]
    // A bad URL throws instead of being skipped: a descriptor that silently
    // resolved to nothing would render as a missing clip, and the operator
    // would go looking for the file instead of for the typo.
    if (raw) sources[quality] = assertUpstreamMediaUrl(raw, `${quality} media link url`)
  }
  if (Object.keys(sources).length === 0) return null
  return {
    ...(typeof value.fileName === 'string' ? { fileName: value.fileName } : {}),
    ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
    sources,
  }
}

/**
 * Resolve a media id to the source the render should read: a file on disk or a
 * link to another host.
 *
 * `quality: 'proxy'` prefers the light copy and falls back to whatever exists;
 * the default prefers the original, and a local file always counts as one. The
 * returned `quality` says which copy was actually picked, so the caller can
 * warn when an export is about to be built from a proxy.
 *
 * @returns {{ kind: 'file', quality: string, path: string }
 *   | { kind: 'link', quality: string, url: string, mimeType?: string, fileName?: string }
 *   | null}
 */
export function resolveMediaSource(workspaceDir, mediaId, { quality = 'original' } = {}) {
  const filePath = resolveMediaFile(workspaceDir, mediaId)
  const file = filePath ? { kind: 'file', quality: 'original', path: filePath } : null
  const link = readMediaLink(workspaceDir, mediaId)
  const linked = (want) =>
    link?.sources[want]
      ? {
          kind: 'link',
          quality: want,
          url: link.sources[want],
          ...(link.mimeType ? { mimeType: link.mimeType } : {}),
          ...(link.fileName ? { fileName: link.fileName } : {}),
        }
      : null
  if (quality === 'proxy') return linked('proxy') ?? file ?? linked('original')
  return file ?? linked('original') ?? linked('proxy')
}

/**
 * Resolve media ids to the sources a render will read.
 * @returns {{ sources: Map<string,object>, missing: string[] }}
 */
export function resolveMediaSources(workspaceDir, mediaIds, { quality = 'original' } = {}) {
  const sources = new Map()
  const missing = []
  for (const mediaId of mediaIds) {
    const source = resolveMediaSource(workspaceDir, mediaId, { quality })
    if (source) sources.set(mediaId, source)
    else missing.push(mediaId)
  }
  return { sources, missing }
}

/** Accept the legacy `(mediaId) => absolutePath` resolver shape alongside descriptors. */
export function normalizeMediaSource(value) {
  if (!value) return null
  return typeof value === 'string' ? { kind: 'file', quality: 'original', path: value } : value
}

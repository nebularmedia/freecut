#!/usr/bin/env node
// FreeCut headless stabilization sweep.
//
// Stabilizes the video clips of a finished edit, one shot at a time, inside headless Chrome —
// running the exact pipeline the editor runs, not a second implementation.
//
// It works on the TIMELINE, after the cuts. Each clip is rendered over its own source span, so a
// ten-minute rush that contributes four seconds to the montage costs four seconds of render. Each
// finished shot is committed to the workspace before the next one starts, so a sweep that dies on
// shot 12 keeps shots 1-11 and can be re-run to continue.
//
// Usage:
//   node headless/stabilize.mjs --workspace <dir> --project <id|project.json> [options]
//
// Options:
//   --strength <gentle|standard|strong>  Framing to spend. Default: standard (10% crop)
//   --clip <id>          Stabilize only this clip instead of sweeping the timeline
//   --out <id>           Write the result as a NEW project with this id (default: <project>-stabilized)
//   --in-place           Overwrite the source project instead (destructive — explicit opt-in)
//   --dry-run            List the shots that would be stabilized and exit
//   --build              Build dist/ first if the harness isn't built
//   --harness-url <url>  Dev mode: drive a running Vite dev server instead of dist/
//   --head               Run headed (visible browser) for debugging
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseArgs, chromeLaunchArgs } from './lib/cli.mjs'
import { loadProject, readMediaMetadata } from './lib/workspace.mjs'
import { withHarnessPage } from './lib/page-session.mjs'
import { startHarness } from './lib/render-core.mjs'
import { commitStagedMedia, rollbackStagedMedia, stageLocalMedia } from './lib/lifecycle-store.mjs'

const OPTIONS = new Set([
  'workspace',
  'project',
  'strength',
  'clip',
  'out',
  'in-place',
  'dry-run',
  'build',
  'harness-url',
  'head',
])

/** Framing kept per strength. Mirrors STRENGTH_CROP_RATIO in the app; the reciprocal is the zoom. */
const CROP_RATIO = { gentle: 0.95, standard: 0.9, strong: 0.85 }

/** Applied to generated media so a re-run can tell what it has already done. */
const STABILIZED_TAG = 'stabilized'

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000

function fail(message) {
  console.error(`stabilize: ${message}`)
  process.exit(1)
}

/**
 * The span of its source that a clip actually plays, in seconds.
 *
 * Mirrors `getItemSourceSpanSeconds` in the app. `sourceEnd` is usually present; when it is not,
 * it is derived from the clip's timeline length, undoing the speed multiplier — a clip at 2x
 * consumes twice the source it occupies.
 */
function sourceSpanSeconds(item, timelineFps) {
  const sourceFps = item.sourceFps ?? timelineFps
  if (!(sourceFps > 0)) return null
  const start = item.sourceStart ?? 0
  const speed = item.speed ?? 1
  const derivedFrames = (item.durationInFrames * speed * sourceFps) / timelineFps
  const end = item.sourceEnd ?? start + derivedFrames
  if (!(end > start)) return null
  return { startSeconds: start / sourceFps, endSeconds: end / sourceFps, sourceFps }
}

/** Video clips of a finished edit, in timeline order, skipping what is already stabilized. */
function collectShots(workspace, project, { clipId }) {
  const timelineFps = project.timeline?.fps ?? project.metadata?.fps ?? 30
  const items = project.timeline?.items ?? []
  const shots = []
  const skipped = []

  for (const item of items) {
    if (item.type !== 'video' || !item.mediaId) continue
    if (clipId && item.id !== clipId) continue

    const metadata = readMediaMetadata(workspace, item.mediaId)
    if (metadata?.tags?.includes(STABILIZED_TAG)) {
      skipped.push({ id: item.id, reason: 'already stabilized' })
      continue
    }
    const span = sourceSpanSeconds(item, timelineFps)
    if (!span) {
      skipped.push({ id: item.id, reason: 'unusable source span' })
      continue
    }
    shots.push({ item, span, metadata })
  }

  shots.sort((a, b) => a.item.from - b.item.from)
  return { shots, skipped, timelineFps }
}

/** `08-albahaca.mp4` becomes `08-albahaca (stabilized).mp4`. */
function stabilizedFileName(fileName) {
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  return `${base} (stabilized).mp4`
}

/**
 * Render one shot and commit it into the workspace as a new media item.
 *
 * Committing per shot rather than at the end is what makes the sweep resumable: the bytes are on
 * disk and registered before the next shot is even decoded.
 */
async function stabilizeShot({ page, shot, mediaUrlOf, workspace, cropRatio, tmpDir }) {
  const { item, span, metadata } = shot
  const url = mediaUrlOf(item.mediaId, 'original')
  if (!url) throw new Error(`No media URL for ${item.mediaId}`)

  const fileName = stabilizedFileName(metadata?.fileName ?? `${item.mediaId}.mp4`)
  const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS })
  downloadPromise.catch(() => {})

  const result = await page.evaluate((input) => window.freecut.stabilizeClip(input), {
    url,
    fileName,
    sourceFps: span.sourceFps,
    cropRatio,
    range: { startSeconds: span.startSeconds, endSeconds: span.endSeconds },
  })

  const download = await downloadPromise
  const tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.mp4`)
  await download.saveAs(tmpPath)

  const mediaId = crypto.randomUUID()
  const staged = await stageLocalMedia(workspace, tmpPath, mediaId)
  try {
    // Probe through the harness so the metadata is derived by the same decoder the editor uses,
    // rather than being asserted from the render's own report.
    const probe = await page.evaluate((input) => window.freecut.probeMedia(input), {
      url: mediaUrlOf(mediaId, 'original'),
      fileName: staged.fileName,
    })
    // No project link. `media-links.json` indexes a project's media, and the shot being rendered
    // belongs to the SOURCE project while this render belongs to the target — which may not exist
    // yet, and on an --out sweep is a different project entirely. The media itself is fully
    // resolvable from `media/{id}/`, which is what every reader actually uses.
    await commitStagedMedia(staged, probe, { workspace })
  } catch (error) {
    await rollbackStagedMedia(staged)
    throw error
  } finally {
    await fs.promises.rm(tmpPath, { force: true })
  }

  // The tag is what a re-run reads to know this shot is done.
  const metadataFile = path.join(workspace, 'media', mediaId, 'metadata.json')
  const committed = JSON.parse(await fs.promises.readFile(metadataFile, 'utf8'))
  committed.tags = [...new Set([...(committed.tags ?? []), STABILIZED_TAG])]
  await fs.promises.writeFile(metadataFile, `${JSON.stringify(committed, null, 2)}\n`)

  return { mediaId, result, metadata: committed }
}

/**
 * Repoint a clip at its stabilized render.
 *
 * The render already covers only this clip, so the new source starts where the clip starts and the
 * trim collapses. Position, length, speed, transform, effects and audio settings are untouched —
 * stabilization is not supposed to move the edit.
 */
function repointClip(item, mediaId, metadata) {
  const sourceFps = metadata.fps > 0 ? metadata.fps : item.sourceFps
  const sourceFrames = Math.max(1, Math.round(metadata.duration * sourceFps))
  return {
    ...item,
    mediaId,
    // A blob URL is session-scoped and never survives to disk; the app re-resolves it from mediaId.
    src: '',
    sourceStart: 0,
    sourceEnd: sourceFrames,
    sourceDuration: sourceFrames,
    sourceFps,
    trimStart: 0,
    trimEnd: 0,
    // Every reverse conform describes ranges of the old source and is now a lie.
    reverseConformSrc: undefined,
    reverseConformPath: undefined,
    reverseConformKey: undefined,
    reverseConformPreviewSrc: undefined,
    reverseConformPreviewPath: undefined,
    reverseConformPreviewKey: undefined,
    reverseConformStatus: undefined,
    reverseConformLocalStart: undefined,
  }
}

function writeProject(workspace, project, { projectId, inPlace, outId }) {
  const targetId = inPlace ? projectId : outId
  const dir = path.join(workspace, 'projects', targetId)
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const next = {
    ...project,
    id: targetId,
    name: inPlace ? project.name : `${project.name} (stabilized)`,
    updatedAt: now,
  }
  fs.writeFileSync(path.join(dir, 'project.json'), `${JSON.stringify(next, null, 2)}\n`)
  return path.join(dir, 'project.json')
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { allowed: OPTIONS })
  if (!args.workspace) fail('--workspace is required')
  if (!args.project) fail('--project is required')

  const strength = args.strength ?? 'standard'
  const cropRatio = CROP_RATIO[strength]
  if (!cropRatio) fail(`--strength must be one of: ${Object.keys(CROP_RATIO).join(', ')}`)

  const workspace = path.resolve(args.workspace)
  const { project, projectJsonPath } = loadProject(workspace, args.project)
  const projectId = project.id
  const inPlace = args['in-place'] === true
  const outId = args.out ?? `${projectId}-stabilized`

  const { shots, skipped } = collectShots(workspace, project, { clipId: args.clip })
  console.log(`project: ${project.name} (${projectJsonPath})`)
  console.log(`shots to stabilize: ${shots.length}, skipped: ${skipped.length}`)
  for (const entry of skipped) console.log(`  skip ${entry.id}: ${entry.reason}`)
  for (const shot of shots) {
    const seconds = (shot.span.endSeconds - shot.span.startSeconds).toFixed(2)
    console.log(
      `  shot ${shot.item.id}: ${seconds}s of ${shot.metadata?.fileName ?? shot.item.mediaId}`,
    )
  }

  if (args['dry-run'] || shots.length === 0) {
    if (shots.length === 0) console.log('nothing to do')
    return
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freecut-stabilize-'))
  const harness = await startHarness({
    workspace,
    devUrl: args['harness-url'],
    build: args.build === true,
  })

  const stabilized = new Map()
  try {
    await withHarnessPage(
      {
        harnessUrl: harness.harnessUrl,
        headless: args.head !== true,
        launchArgs: chromeLaunchArgs(),
        acceptDownloads: true,
      },
      async (page) => {
        // One at a time on purpose: the render saturates the machine, and two concurrent shots
        // make both slower without finishing either sooner.
        for (const [index, shot] of shots.entries()) {
          const label = `[${index + 1}/${shots.length}] ${shot.item.id}`
          console.log(`${label} stabilizing…`)
          const outcome = await stabilizeShot({
            page,
            shot,
            mediaUrlOf: harness.mediaUrlOf,
            workspace,
            cropRatio,
            tmpDir,
          })
          stabilized.set(shot.item.id, outcome)
          const floor = outcome.result.attenuationFloor
          const note = floor < 0.85 ? ` (crop ran out; ${Math.round(floor * 100)}% applied)` : ''
          console.log(`${label} done → ${outcome.mediaId}${note}`)
        }
      },
    )
  } finally {
    await harness.closeServers()
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }

  const items = (project.timeline?.items ?? []).map((item) => {
    const outcome = stabilized.get(item.id)
    return outcome ? repointClip(item, outcome.mediaId, outcome.metadata) : item
  })
  const nextProject = { ...project, timeline: { ...project.timeline, items } }
  const written = writeProject(workspace, nextProject, { projectId, inPlace, outId })
  console.log(`stabilized ${stabilized.size} shot(s) → ${written}`)
}

main().catch((error) => {
  fail(error?.stack ?? String(error))
})

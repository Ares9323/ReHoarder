import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { DownloadsRepo } from './db/downloads-repo'

export interface CreateProjectRequest {
  source: string
  sourceId: string
  engineVersion: string | null
  /** Folder name AND .uproject base name. The caller already sanitised it. */
  name: string
  /** Absolute path to the parent directory (must be inside one of `settings.projectPaths`). */
  parentDir: string
}

export interface CreateProjectResult {
  ok: boolean
  error?: string
  projectDir?: string
  uprojectPath?: string
  filesCopied?: number
  bytesCopied?: number
}

/**
 * Materialise a downloaded `COMPLETE_PROJECT` asset as a fresh Unreal project
 * folder. Copies the on-disk vault payload into `<parentDir>/<name>/` and
 * renames the contained `.uproject` to match the chosen folder name (so the
 * Editor's "Recent Projects" list shows the right thing).
 *
 * Refuses to overwrite an existing folder — the user picks a name explicitly
 * in the dialog, and silently merging would risk confusing two builds.
 */
export async function createProjectFromVault(
  repo: DownloadsRepo,
  req: CreateProjectRequest
): Promise<CreateProjectResult> {
  const candidates = repo
    .listAll()
    .filter(
      (r) =>
        r.status === 'done' &&
        r.source === req.source &&
        r.sourceId === req.sourceId &&
        (req.engineVersion === null || r.engineVersion === req.engineVersion) &&
        r.destDir !== null
    )
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))

  if (candidates.length === 0) {
    return {
      ok: false,
      error:
        `No completed download in the local vault for ${req.source}/${req.sourceId}` +
        (req.engineVersion ? ` (engine ${req.engineVersion})` : '')
    }
  }
  const row = candidates[0]
  const assetDir = row.destDir as string

  const wrappedDataDir = path.join(assetDir, 'data')
  let sourceRoot: string
  try {
    const s = await fsp.stat(wrappedDataDir)
    sourceRoot = s.isDirectory() ? wrappedDataDir : assetDir
  } catch {
    sourceRoot = assetDir
  }

  // Locate the original `.uproject` file inside the source — that's what we
  // need to rename to the user's chosen name.
  let originalUprojectName: string | null = null
  try {
    const entries = await fsp.readdir(sourceRoot)
    for (const e of entries) {
      if (e.toLowerCase().endsWith('.uproject')) {
        originalUprojectName = e
        break
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: `Cannot read source: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (!originalUprojectName) {
    return {
      ok: false,
      error:
        'No .uproject file at the top of the vault payload — this asset may not be a full project.'
    }
  }

  const projectDir = path.join(req.parentDir, req.name)
  try {
    await fsp.stat(projectDir)
    return {
      ok: false,
      error: `Project folder already exists: ${projectDir}`
    }
  } catch {
    // good — the target doesn't exist yet
  }

  let filesCopied = 0
  let bytesCopied = 0
  await fsp.mkdir(projectDir, { recursive: true })
  await walkAndCopy(sourceRoot, sourceRoot, projectDir, (bytes) => {
    filesCopied += 1
    bytesCopied += bytes
  })

  const oldUprojectPath = path.join(projectDir, originalUprojectName)
  const newUprojectPath = path.join(projectDir, req.name + '.uproject')
  if (oldUprojectPath !== newUprojectPath) {
    try {
      await fsp.rename(oldUprojectPath, newUprojectPath)
    } catch (err) {
      // Non-fatal: the rest of the project is in place; the user can rename
      // manually if needed. Still surface it as a warning.
      console.warn('[projects-create] could not rename .uproject:', err)
    }
  }

  // Stamp a `.rehoarder.json` next to the .uproject so the Projects scanner
  // can later cross-reference back to the source asset (and pull the thumbnail
  // out of `assets.image_url`). Non-fatal: a project without the marker still
  // works, it just won't show a thumbnail.
  try {
    const marker = {
      version: 1,
      source: req.source,
      sourceId: req.sourceId,
      engineVersion: req.engineVersion,
      createdAt: Date.now()
    }
    await fsp.writeFile(
      path.join(projectDir, '.rehoarder.json'),
      JSON.stringify(marker, null, 2) + '\n',
      'utf-8'
    )
  } catch (err) {
    console.warn('[projects-create] could not write .rehoarder.json marker:', err)
  }

  return {
    ok: true,
    projectDir,
    uprojectPath: newUprojectPath,
    filesCopied,
    bytesCopied
  }
}

async function walkAndCopy(
  current: string,
  sourceRoot: string,
  targetRoot: string,
  onFile: (bytes: number) => void
): Promise<void> {
  let entries
  try {
    entries = await fsp.readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const abs = path.join(current, e.name)
    if (e.isDirectory()) {
      await walkAndCopy(abs, sourceRoot, targetRoot, onFile)
      continue
    }
    if (!e.isFile()) continue
    const rel = path.relative(sourceRoot, abs)
    const dest = path.join(targetRoot, rel)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(abs, dest)
    try {
      const s = await fsp.stat(dest)
      onFile(s.size)
    } catch {
      onFile(0)
    }
  }
}

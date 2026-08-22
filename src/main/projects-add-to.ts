import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { DownloadsRepo } from './db/downloads-repo'
import { isEngineCompatible, parseEngineVersion } from '../shared/engine-version'

export type AddToProjectConflict = 'skip' | 'overwrite'

export interface AddToProjectRequest {
  source: string
  sourceId: string
  engineVersion: string | null
  /** The target project's `EngineAssociation`, used for the `>= required`
   *  compatibility guard (defence in depth against the dialog). */
  targetEngineVersion: string | null
  /** Absolute path to the `.uproject`'s parent directory. */
  projectDir: string
  /** What to do when a file already exists at the destination. */
  conflict: AddToProjectConflict
  /** When set, used directly as the asset folder (the folder containing
   *  `data/`), skipping the `downloads`-row lookup entirely. For orphan
   *  vault assets that have no matching download row (hand-copied, or
   *  downloaded before ReHoarder tracked them). */
  vaultAssetDir?: string
}

export interface AddToProjectResult {
  ok: boolean
  error?: string
  /** Absolute path of the source `Content/` directory we found (or the vault root if we copied everything). */
  sourceContentDir?: string
  /** Resolved `<projectDir>/Content/`. */
  destContentDir?: string
  filesCopied?: number
  filesSkipped?: number
  bytesCopied?: number
}

/**
 * Merge an `ASSET_PACK` download into an existing project's `Content/` folder.
 *
 * Layout assumption: Fab asset packs unpack with a `Content/` directory
 * somewhere in the first 3 levels under the asset folder. The packers vary
 * (`data/Content/...`, `data/<AssetName>/Content/...`, etc.), so we walk for
 * the first one we find and stop there. We never silently descend past that.
 *
 * Conflict policy is per-file: `skip` leaves the existing file untouched,
 * `overwrite` replaces it. Either way the result reports the counts so the
 * UI can show "X files added, Y skipped".
 */
export async function addToProject(
  repo: DownloadsRepo,
  req: AddToProjectRequest
): Promise<AddToProjectResult> {
  // Only enforce the guard when the asset's required engine version is
  // known. An unparsable/missing required version means we can't verify
  // compatibility either way, so we allow the copy — matching the Local
  // Vault UI, which shows an advisory warning instead of blocking.
  if (
    parseEngineVersion(req.engineVersion) !== null &&
    !isEngineCompatible(req.engineVersion, req.targetEngineVersion)
  ) {
    return {
      ok: false,
      error:
        `Target project engine ${req.targetEngineVersion || '(unknown)'} is older than ` +
        `the asset's ${req.engineVersion || '(unknown)'} (or unparsable) — refusing to copy.`
    }
  }

  let assetDir: string
  if (req.vaultAssetDir) {
    assetDir = req.vaultAssetDir
  } else {
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
    assetDir = candidates[0].destDir as string
  }

  const wrappedDataDir = path.join(assetDir, 'data')
  let sourceRoot: string
  try {
    const s = await fsp.stat(wrappedDataDir)
    sourceRoot = s.isDirectory() ? wrappedDataDir : assetDir
  } catch {
    sourceRoot = assetDir
  }

  const sourceContentDir = await findContentDir(sourceRoot)
  if (!sourceContentDir) {
    return {
      ok: false,
      error:
        'No Content/ folder found inside the vault payload — is this really an asset pack?'
    }
  }

  // Verify the project's uproject exists — guard against arbitrary directories.
  let foundUproject = false
  try {
    const entries = await fsp.readdir(req.projectDir)
    for (const e of entries) {
      if (e.toLowerCase().endsWith('.uproject')) {
        foundUproject = true
        break
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: `Cannot read project directory: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (!foundUproject) {
    return {
      ok: false,
      error: `${req.projectDir} doesn't look like an Unreal project (no .uproject file).`
    }
  }

  const destContentDir = path.join(req.projectDir, 'Content')
  await fsp.mkdir(destContentDir, { recursive: true })

  let filesCopied = 0
  let filesSkipped = 0
  let bytesCopied = 0
  await walkAndMerge(
    sourceContentDir,
    sourceContentDir,
    destContentDir,
    req.conflict,
    (kind, bytes) => {
      if (kind === 'copied') {
        filesCopied += 1
        bytesCopied += bytes
      } else {
        filesSkipped += 1
      }
    }
  )

  return {
    ok: true,
    sourceContentDir,
    destContentDir,
    filesCopied,
    filesSkipped,
    bytesCopied
  }
}

async function findContentDir(root: string, maxDepth = 3): Promise<string | null> {
  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > maxDepth) return null
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    // Direct hit takes priority over recursion.
    for (const e of entries) {
      if (e.isDirectory() && e.name === 'Content') {
        return path.join(dir, 'Content')
      }
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const r = await walk(path.join(dir, e.name), depth + 1)
        if (r) return r
      }
    }
    return null
  }
  return await walk(root, 0)
}

async function walkAndMerge(
  current: string,
  sourceRoot: string,
  destRoot: string,
  conflict: AddToProjectConflict,
  onFile: (kind: 'copied' | 'skipped', bytes: number) => void
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
      await walkAndMerge(abs, sourceRoot, destRoot, conflict, onFile)
      continue
    }
    if (!e.isFile()) continue
    const rel = path.relative(sourceRoot, abs)
    const dest = path.join(destRoot, rel)
    let exists = false
    try {
      await fsp.access(dest)
      exists = true
    } catch {
      exists = false
    }
    if (exists && conflict === 'skip') {
      onFile('skipped', 0)
      continue
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(abs, dest)
    try {
      const s = await fsp.stat(dest)
      onFile('copied', s.size)
    } catch {
      onFile('copied', 0)
    }
  }
}

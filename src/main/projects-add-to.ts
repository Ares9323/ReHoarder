import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { DownloadsRepo } from './db/downloads-repo'
import { isEngineCompatible, parseEngineVersion } from '../shared/engine-version'
import {
  isDefaultDestination,
  type AddToProjectDestination
} from '../shared/relocate-destination'
import { listTopLevelFolders } from './projects-relocate-plan'

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
  /** Where the pack lands. Omitted or default (Content, no subfolder, no
   *  rename) keeps the plain fast merge into `<project>/Content`. */
  destination?: AddToProjectDestination
}

/** Runs the editor-backed relocation (see `projects-relocate.ts`). Injected so
 *  this module stays free of Electron and child processes. */
export type RelocateFn = (ctx: {
  sourceContentDir: string
  uprojectPath: string
}) => Promise<AddToProjectResult>

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
  /** Relocation only: the job was cancelled by the user (nothing was copied). */
  cancelled?: boolean
  /** Relocation only: succeeded, but something deserves the user's attention. */
  warning?: string
  /** Relocation only: Unreal package path the pack now lives under. */
  destinationPath?: string
  /** Relocation only, on failure: tail of the editor output. */
  output?: string
  /** Relocation only, on failure: the generated Python script, for diagnosis. */
  script?: string
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
  req: AddToProjectRequest,
  relocate?: RelocateFn
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

  const pack = await resolvePackContentDir(repo, req)
  if ('error' in pack) return { ok: false, error: pack.error }
  const sourceContentDir = pack.contentDir

  // Verify the project's uproject exists — guard against arbitrary directories.
  let uprojectName: string | undefined
  try {
    const entries = await fsp.readdir(req.projectDir)
    uprojectName = entries.find((e) => e.toLowerCase().endsWith('.uproject'))
  } catch (err) {
    return {
      ok: false,
      error: `Cannot read project directory: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (!uprojectName) {
    return {
      ok: false,
      error: `${req.projectDir} doesn't look like an Unreal project (no .uproject file).`
    }
  }

  if (req.destination) {
    const topFolders = await listTopLevelFolders(sourceContentDir)
    if (!isDefaultDestination(req.destination, topFolders)) {
      if (!relocate) {
        return { ok: false, error: 'Relocating into a subfolder or plugin is not available here' }
      }
      return await relocate({
        sourceContentDir,
        uprojectPath: path.join(req.projectDir, uprojectName)
      })
    }
  }

  const destContentDir = path.join(req.projectDir, 'Content')
  await fsp.mkdir(destContentDir, { recursive: true })

  let filesCopied = 0
  let filesSkipped = 0
  let bytesCopied = 0
  await mergeDir(sourceContentDir, destContentDir, req.conflict, (kind, bytes) => {
    if (kind === 'copied') {
      filesCopied += 1
      bytesCopied += bytes
    } else {
      filesSkipped += 1
    }
  })

  return {
    ok: true,
    sourceContentDir,
    destContentDir,
    filesCopied,
    filesSkipped,
    bytesCopied
  }
}

/**
 * Locate the pack's source `Content/` directory: either inside the explicit
 * `vaultAssetDir` or inside the newest completed download matching
 * (source, sourceId, engineVersion).
 */
export async function resolvePackContentDir(
  repo: DownloadsRepo,
  req: Pick<AddToProjectRequest, 'source' | 'sourceId' | 'engineVersion' | 'vaultAssetDir'>
): Promise<{ contentDir: string } | { error: string }> {
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

  const contentDir = await findContentDir(sourceRoot)
  if (!contentDir) {
    return {
      error: 'No Content/ folder found inside the vault payload — is this really an asset pack?'
    }
  }
  return { contentDir }
}

export async function findContentDir(root: string, maxDepth = 3): Promise<string | null> {
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

/**
 * Copy every file under `sourceRoot` into `destRoot` (same relative layout),
 * honouring the per-file conflict policy. Shared with the relocation job's
 * copy-out step.
 */
export async function mergeDir(
  sourceRoot: string,
  destRoot: string,
  conflict: AddToProjectConflict,
  onFile: (kind: 'copied' | 'skipped', bytes: number) => void
): Promise<void> {
  await walkAndMerge(sourceRoot, sourceRoot, destRoot, conflict, onFile)
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

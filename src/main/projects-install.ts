import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { DownloadsRepo } from './db/downloads-repo'

export interface InstallFromVaultRequest {
  source: string
  sourceId: string
  /** Pass when targeting a specific engine version's build; null = "any". */
  engineVersion: string | null
  /** Either an engine root (`<engine>`) or a project's `Plugins` folder (`<project>/Plugins`). */
  targetPath: string
  /** Drives prefix stripping: engine install keeps `Engine/Plugins/Marketplace/`, project install strips it. */
  kind: 'engine' | 'project'
}

export interface InstallFromVaultResult {
  ok: boolean
  error?: string
  /** Absolute path of the directory we copied into (`<engine>` or `<project>/Plugins/<plugin>`). */
  destPath?: string
  filesCopied?: number
  bytesCopied?: number
  /** Path of the source vault folder we copied FROM — handy for debug logs. */
  sourceVaultPath?: string
}

/**
 * Locate a completed `downloads` row for the asset, walk its on-disk payload,
 * and copy the file tree into the requested engine/project location. Mirrors
 * the live-download orchestrator's prefix-strip / data-wrap logic so the same
 * source tree can be installed into different targets without re-downloading.
 *
 * Resolution order for the source directory:
 *   1. Latest done download for (source, sourceId, engineVersion=match) — if engineVersion is set.
 *   2. Latest done download for (source, sourceId) — anything goes (no engineVersion filter).
 *   3. Fail with a clear error.
 *
 * Inside that download we accept either `dest_dir/data/...` (legacy vault
 * layout) or `dest_dir/...` (`noWrapDataDir=true`, used by plugin installs).
 */
export async function installFromVault(
  repo: DownloadsRepo,
  req: InstallFromVaultRequest
): Promise<InstallFromVaultResult> {
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
  if (candidates.length === 0) {
    return {
      ok: false,
      error:
        `No completed download in the local vault for ${req.source}/${req.sourceId}` +
        (req.engineVersion ? ` (engine ${req.engineVersion})` : '')
    }
  }
  // Prefer the most recently finished download.
  candidates.sort(
    (a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)
  )
  const row = candidates[0]
  const assetDir = row.destDir as string

  // Try `<assetDir>/data/` first (legacy vault wrap), then `<assetDir>/` itself.
  const wrappedDataDir = path.join(assetDir, 'data')
  let sourceRoot: string
  try {
    const s = await fsp.stat(wrappedDataDir)
    sourceRoot = s.isDirectory() ? wrappedDataDir : assetDir
  } catch {
    sourceRoot = assetDir
  }
  try {
    const s = await fsp.stat(sourceRoot)
    if (!s.isDirectory()) {
      return { ok: false, error: `Vault source path is not a directory: ${sourceRoot}` }
    }
  } catch (err) {
    return {
      ok: false,
      error: `Vault source path missing: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // For project installs we strip the engine-relative prefix so files land in
  // `<project>/Plugins/<plugin>/...` instead of `<project>/Plugins/Engine/...`.
  const stripPrefix = req.kind === 'project' ? 'Engine/Plugins/Marketplace/' : ''

  let filesCopied = 0
  let bytesCopied = 0
  await fsp.mkdir(req.targetPath, { recursive: true })
  await walkAndCopy(sourceRoot, sourceRoot, req.targetPath, stripPrefix, (bytes) => {
    filesCopied += 1
    bytesCopied += bytes
  })

  return {
    ok: true,
    destPath: req.targetPath,
    filesCopied,
    bytesCopied,
    sourceVaultPath: sourceRoot
  }
}

/**
 * Recursive copy: every regular file under `current` is written to
 * `<targetRoot>/<rel(stripped)>`. `stripPrefix` is matched against the
 * forward-slashed relative path so the comparison is OS-agnostic.
 */
async function walkAndCopy(
  current: string,
  sourceRoot: string,
  targetRoot: string,
  stripPrefix: string,
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
      await walkAndCopy(abs, sourceRoot, targetRoot, stripPrefix, onFile)
      continue
    }
    if (!e.isFile()) continue
    const relRaw = path.relative(sourceRoot, abs).replace(/\\/g, '/')
    const rel = stripPrefix && relRaw.startsWith(stripPrefix)
      ? relRaw.slice(stripPrefix.length)
      : relRaw
    if (!rel) continue
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

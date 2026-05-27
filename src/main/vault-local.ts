import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

/**
 * High-level kind of a vault payload, inferred from its `data/` layout.
 * - `asset`: `data/Content/...` (the typical Fab asset pack — meshes /
 *   materials / blueprints under a `Content/` folder, sometimes with
 *   `Config/` or `Platforms/` siblings).
 * - `plugin`: `data/Engine/Plugins/Marketplace/<name>/<name>.uplugin` —
 *   an engine plugin install, intended to land in an UE install's
 *   `Engine/Plugins/Marketplace/` directory.
 * - `unknown`: neither shape recognised (in-flight download, hand-copied
 *   folder without `data/`, or a payload we don't have a rule for yet).
 */
export type LocalVaultKind = 'asset' | 'plugin' | 'unknown'

export interface LocalVaultEntry {
  /** Sub-directory name (= sanitized artifactId from `downloadAsset()`). */
  name: string
  /** Human-readable title of the asset, looked up via the `downloads` table. `null` when no matching done-download row exists (e.g. legacy entries written before we tracked them, or copied in by hand). */
  friendlyName: string | null
  /** Asset thumbnail URL pulled from `assets.image_url` for the matching download row. `null` when there's no DB-side info. */
  imageUrl: string | null
  /** Absolute path of the asset directory (the one containing `data/`). */
  path: string
  /** The configured root path the entry was discovered under. */
  rootPath: string
  /** Sum of byte sizes of every regular file under the entry. */
  totalBytes: number
  /** Number of regular files (excluding `cache/` if present). */
  fileCount: number
  /** Epoch ms of the newest mtime under the entry, or 0 if empty. */
  lastModified: number
  /** True when the entry contains a `data/` subdirectory (= a successful download). */
  hasData: boolean
  /** Inferred shape of the payload (see {@link LocalVaultKind}). */
  kind: LocalVaultKind
  /** Source asset record from the `downloads` table — filled by the IPC layer. */
  source: 'vault' | 'fab' | 'legacy' | null
  sourceId: string | null
  /** Engine version recorded on the download row (`5.4`, `4.27`, …). Null when the download predates per-version tracking. */
  engineVersion: string | null
}

/**
 * Enumerate top-level entries under each path in `vaultDirs`. Each top-level
 * subdirectory is treated as one local asset. For each entry we walk its
 * contents and accumulate total bytes, file count, and the newest mtime.
 * The `cache/` subdirectory (used while a download is in flight) is skipped
 * from the counts so users see the actual on-disk asset size, not the
 * chunk cache.
 *
 * Returns entries sorted by `lastModified` descending — newest downloads
 * first. If two configured roots produce an entry at the same absolute path
 * (e.g. one is a prefix of the other), the first wins.
 */
export async function listLocalVault(vaultDirs: string[]): Promise<LocalVaultEntry[]> {
  const entries: LocalVaultEntry[] = []
  const seenPaths = new Set<string>()

  for (const vaultDir of vaultDirs) {
    let topNames: string[]
    try {
      topNames = await fsp.readdir(vaultDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      // permission errors / I/O errors on one root shouldn't fail the whole list
      console.warn(`[vault] could not read "${vaultDir}":`, err)
      continue
    }

    // Scan every top-level entry in parallel — the per-asset walk is the
    // expensive part (recursive stat over thousands of files per asset),
    // and there's no shared mutable state across entries. On a 50-asset
    // vault this turns the wall time from ~sum(perAsset) into ~max(perAsset).
    // Stays in-process: each walk's stats hit the libuv thread pool (default
    // 4 threads) but `Promise.all` keeps them all pending simultaneously
    // instead of one-at-a-time.
    const perEntry = await Promise.all(
      topNames.map(async (name) => {
        const entryPath = path.join(vaultDir, name)
        const key = path.resolve(entryPath).toLowerCase()
        let stat
        try {
          stat = await fsp.stat(entryPath)
        } catch {
          return null
        }
        if (!stat.isDirectory()) return null
        const [walked, hasData, kind] = await Promise.all([
          walkEntry(entryPath),
          fsp
            .stat(path.join(entryPath, 'data'))
            .then((ds) => ds.isDirectory())
            .catch(() => false),
          detectKind(path.join(entryPath, 'data'))
        ])
        const entry: LocalVaultEntry = {
          name,
          // `friendlyName`, `imageUrl`, `source`, `sourceId`, `engineVersion`
          // are filled in by the IPC layer (where we have access to the
          // downloads + assets repos). Keep them `null` here so the on-disk
          // scanner stays self-contained and easy to test without a DB.
          friendlyName: null,
          imageUrl: null,
          path: entryPath,
          rootPath: vaultDir,
          totalBytes: walked.totalBytes,
          fileCount: walked.fileCount,
          lastModified: walked.lastModified,
          hasData,
          kind,
          source: null,
          sourceId: null,
          engineVersion: null
        }
        return { entry, key }
      })
    )
    for (const item of perEntry) {
      if (!item) continue
      if (seenPaths.has(item.key)) continue
      seenPaths.add(item.key)
      entries.push(item.entry)
    }
  }

  entries.sort((a, b) => b.lastModified - a.lastModified)
  return entries
}

interface WalkResult {
  totalBytes: number
  fileCount: number
  lastModified: number
}

/**
 * Identify whether `<entry>/data/` looks like a plugin install or an asset
 * pack. We only inspect the *immediate* children of `data/` (cheap — one
 * `readdir`); going deeper would slow the scan unnecessarily since the two
 * shapes are well-defined at the top level:
 *   - plugin → `data/Engine/...` (Marketplace plugins always live under
 *     `Engine/Plugins/Marketplace`, so the `Engine` folder at depth 0 is
 *     the giveaway).
 *   - asset → `data/Content/...` (Fab asset packs ship a `Content/` dir
 *     that maps 1:1 into the project's `Content/`; siblings like
 *     `Config/` or `Platforms/` are common for asset packs that ship
 *     project-level configs or per-platform binaries — those don't change
 *     the kind).
 * A folder with both `Engine/` and `Content/` falls back to `'plugin'`
 * (engine-deployed plugins occasionally bundle a small Content/ for demo
 * maps, and the Add-to-project flow doesn't apply to plugins anyway).
 */
async function detectKind(dataDir: string): Promise<LocalVaultKind> {
  let items
  try {
    items = await fsp.readdir(dataDir, { withFileTypes: true })
  } catch {
    return 'unknown'
  }
  let hasEngine = false
  let hasContent = false
  for (const it of items) {
    if (!it.isDirectory()) continue
    if (it.name === 'Engine') hasEngine = true
    else if (it.name === 'Content') hasContent = true
  }
  if (hasEngine) return 'plugin'
  if (hasContent) return 'asset'
  return 'unknown'
}

async function walkEntry(entryPath: string): Promise<WalkResult> {
  const out: WalkResult = { totalBytes: 0, fileCount: 0, lastModified: 0 }
  await walk(entryPath, out, 0)
  return out
}

async function walk(dir: string, out: WalkResult, depth: number): Promise<void> {
  if (depth > 64) return // safety bound
  let items
  try {
    items = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  // Split entries before issuing any I/O so we can fire stats + recursive
  // walks concurrently against the libuv thread pool. Mutating `out` is
  // safe under JS's single-threaded event loop — `+=` on shared counters
  // doesn't race when each Promise resumes one-at-a-time.
  const subdirs: string[] = []
  const files: string[] = []
  for (const item of items) {
    // Skip the chunk cache directory — those are transient and shouldn't
    // contribute to the user-visible asset size.
    if (depth === 0 && item.isDirectory() && item.name === 'cache') continue
    const child = path.join(dir, item.name)
    if (item.isDirectory()) subdirs.push(child)
    else if (item.isFile()) files.push(child)
  }
  await Promise.all([
    Promise.all(
      files.map(async (child) => {
        try {
          const s = await fsp.stat(child)
          out.totalBytes += s.size
          out.fileCount += 1
          if (s.mtimeMs > out.lastModified) out.lastModified = s.mtimeMs
        } catch {
          // skip transient/unreadable files
        }
      })
    ),
    Promise.all(subdirs.map((child) => walk(child, out, depth + 1)))
  ])
}

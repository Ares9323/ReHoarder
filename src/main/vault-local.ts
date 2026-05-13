import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

export interface LocalVaultEntry {
  /** Sub-directory name (= sanitized artifactId from `downloadAsset()`). */
  name: string
  /** Absolute path of the asset directory (the one containing `data/`). */
  path: string
  /** Sum of byte sizes of every regular file under the entry. */
  totalBytes: number
  /** Number of regular files (excluding `cache/` if present). */
  fileCount: number
  /** Epoch ms of the newest mtime under the entry, or 0 if empty. */
  lastModified: number
  /** True when the entry contains a `data/` subdirectory (= a successful download). */
  hasData: boolean
}

/**
 * Enumerate top-level entries under `vaultDir`. Each top-level subdirectory
 * is treated as one local asset. For each entry we walk its contents and
 * accumulate total bytes, file count, and the newest mtime. The `cache/`
 * subdirectory (used while a download is in flight) is skipped from the
 * counts so users see the actual on-disk asset size, not the chunk cache.
 *
 * Returns entries sorted by `lastModified` descending — newest downloads
 * first.
 */
export async function listLocalVault(vaultDir: string): Promise<LocalVaultEntry[]> {
  let topNames: string[]
  try {
    topNames = await fsp.readdir(vaultDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const entries: LocalVaultEntry[] = []
  for (const name of topNames) {
    const entryPath = path.join(vaultDir, name)
    let stat
    try {
      stat = await fsp.stat(entryPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const walked = await walkEntry(entryPath)
    const dataPath = path.join(entryPath, 'data')
    let hasData = false
    try {
      const ds = await fsp.stat(dataPath)
      hasData = ds.isDirectory()
    } catch {
      hasData = false
    }
    entries.push({
      name,
      path: entryPath,
      totalBytes: walked.totalBytes,
      fileCount: walked.fileCount,
      lastModified: walked.lastModified,
      hasData
    })
  }
  entries.sort((a, b) => b.lastModified - a.lastModified)
  return entries
}

interface WalkResult {
  totalBytes: number
  fileCount: number
  lastModified: number
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
  for (const item of items) {
    // Skip the chunk cache directory — those are transient and shouldn't
    // contribute to the user-visible asset size.
    if (depth === 0 && item.isDirectory() && item.name === 'cache') continue
    const child = path.join(dir, item.name)
    if (item.isDirectory()) {
      await walk(child, out, depth + 1)
    } else if (item.isFile()) {
      try {
        const s = await fsp.stat(child)
        out.totalBytes += s.size
        out.fileCount += 1
        if (s.mtimeMs > out.lastModified) out.lastModified = s.mtimeMs
      } catch {
        // skip transient/unreadable files
      }
    }
  }
}

import { ipcMain, shell } from 'electron'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { listLocalVault, type LocalVaultEntry } from './vault-local'
import { broadcastDownloads } from './downloads-ipc'
import { compilePatterns, composeSkipPatterns, matchesAny } from './download/cruft-filter'
import type { DownloadsRepo } from './db/downloads-repo'
import type { AssetsRepo, AssetSource } from './db/assets-repo'
import type { SettingsStore } from './settings'

export interface VaultListResult {
  ok: boolean
  error?: string
  /** Every configured root path that was scanned, in the order the user set. */
  vaultDirs?: string[]
  entries?: LocalVaultEntry[]
}

export interface VaultOpenResult {
  ok: boolean
  error?: string
}

export interface VaultDeleteResult {
  ok: boolean
  error?: string
  /** How many downloads-table rows were detached from this folder (cleared from the Assets tab). */
  downloadRowsRemoved?: number
}

export interface VaultCruftMatch {
  /** Relative to the scanned asset directory, with forward slashes. */
  relPath: string
  size: number
}

export interface VaultCruftScanResult {
  ok: boolean
  error?: string
  matches?: VaultCruftMatch[]
  totalBytes?: number
}

export interface VaultCruftCleanResult {
  ok: boolean
  error?: string
  deletedFiles?: number
  freedBytes?: number
}

/**
 * Walk `root` recursively and call `onFile(absPath, relPath, size)` for every
 * regular file. Relative paths use forward slashes so they can be matched
 * against the cruft-filter regexes directly. Symlinks are not followed.
 */
async function walkFiles(
  root: string,
  onFile: (absPath: string, relPath: string, size: number) => void
): Promise<void> {
  async function recurse(dir: string, prefix: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.isSymbolicLink()) continue
        await recurse(abs, rel)
        continue
      }
      if (!e.isFile()) continue
      try {
        const st = await fsp.stat(abs)
        onFile(abs, rel, st.size)
      } catch {
        // Stat may fail for transient files / locked files — just skip.
      }
    }
  }
  await recurse(root, '')
}

/**
 * After deleting files, climb `root` and remove every directory that ended
 * up empty as a result. Stops at `root` itself (never deletes the scan root).
 */
async function pruneEmptyDirs(root: string): Promise<void> {
  async function recurse(dir: string): Promise<boolean> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let allEmpty = true
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const wasEmpty = await recurse(abs)
        if (!wasEmpty) allEmpty = false
      } else {
        allEmpty = false
      }
    }
    if (allEmpty && dir !== root) {
      try {
        await fsp.rmdir(dir)
        return true
      } catch {
        return false
      }
    }
    return allEmpty
  }
  await recurse(root)
}

/**
 * Register `vault:*` IPCs exposing the local-vault scanner to the renderer.
 *
 * Reads `settings.vaultPaths` live on every call so adding/removing paths
 * in Settings reflects without restart.
 */
export function registerVaultIpc(
  settings: SettingsStore,
  downloadsRepo: DownloadsRepo,
  assetsRepo: AssetsRepo
): void {
  ipcMain.handle('vault:list', async (): Promise<VaultListResult> => {
    try {
      const cfg = settings.load()
      const entries = await listLocalVault(cfg.vaultPaths)
      // Build a `dest_dir → { title, source, sourceId }` lookup once from the
      // completed downloads, then splice friendlyName + thumbnail into each
      // entry. Two-step: title is direct off the row, thumbnail needs an
      // assets-table lookup keyed by (source, sourceId).
      const downloadInfoByPath = new Map<
        string,
        { title: string; source: AssetSource; sourceId: string }
      >()
      for (const row of downloadsRepo.listAll()) {
        if (row.status !== 'done' || !row.destDir) continue
        const key = path.resolve(row.destDir).toLowerCase()
        if (!downloadInfoByPath.has(key)) {
          downloadInfoByPath.set(key, {
            title: row.title,
            source: row.source as AssetSource,
            sourceId: row.sourceId
          })
        }
      }
      for (const e of entries) {
        const key = path.resolve(e.path).toLowerCase()
        const info = downloadInfoByPath.get(key)
        if (!info) continue
        e.friendlyName = info.title
        const asset = assetsRepo.findById(info.source, info.sourceId)
        e.imageUrl = asset?.imageUrl ?? null
      }
      return { ok: true, vaultDirs: cfg.vaultPaths, entries }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[vault] list failed:', msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle(
    'vault:delete',
    async (_e, absolutePath: string): Promise<VaultDeleteResult> => {
      // Strict guard: only paths inside a configured vault root can be removed,
      // and the path itself can't be the root (rm -rf on Vault paths[0] would
      // wipe every download in one go).
      const cfg = settings.load()
      const resolved = path.resolve(absolutePath)
      const root = cfg.vaultPaths
        .map((r) => path.resolve(r))
        .find((r) => resolved.startsWith(r + path.sep))
      if (!root) {
        return { ok: false, error: 'Path is outside the configured vault roots' }
      }
      if (resolved === root) {
        return { ok: false, error: 'Refusing to remove the vault root itself' }
      }
      try {
        await fsp.rm(resolved, { recursive: true, force: true })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      // Drop matching `downloads` rows so the Assets tab stops showing the
      // chips as green/✓. Match on `dest_dir`, lowercase-resolved.
      const wanted = resolved.toLowerCase()
      let removed = 0
      for (const row of downloadsRepo.listAll()) {
        if (!row.destDir) continue
        if (path.resolve(row.destDir).toLowerCase() === wanted) {
          downloadsRepo.remove(row.id)
          removed += 1
        }
      }
      // Push the updated list so the Assets tab repaints the chips immediately
      // (without it the renderer keeps showing the green/done indicator until
      // the next `downloads:state-changed`, which only fires on enqueue/run).
      if (removed > 0) broadcastDownloads(downloadsRepo.listAll())
      return { ok: true, downloadRowsRemoved: removed }
    }
  )

  /**
   * Build the regexes for the current settings and the supplied vault-asset
   * path, guarding against scans outside the configured vault roots. Returns
   * `null` if the path fails the guard (the caller surfaces a friendly error).
   */
  function resolveScanContext(
    absolutePath: string
  ): { absDir: string; patterns: RegExp[] } | { error: string } {
    const cfg = settings.load()
    const resolved = path.resolve(absolutePath)
    const root = cfg.vaultPaths
      .map((r) => path.resolve(r))
      .find((r) => resolved === r || resolved.startsWith(r + path.sep))
    if (!root) {
      return { error: 'Path is outside the configured vault roots' }
    }
    if (resolved === root) {
      // Cleaning the root would scan every asset in one go and is too easy
      // to misclick — require per-asset operations.
      return { error: 'Refusing to scan the vault root itself' }
    }
    const patterns = compilePatterns(
      composeSkipPatterns({
        includeCruft: cfg.skipCruftAtDownload,
        userExtras: cfg.cruftPatterns,
        includePlatformBinaries: cfg.deleteExtraVaultPlatforms
      })
    )
    return { absDir: resolved, patterns }
  }

  ipcMain.handle(
    'vault:scan-cruft',
    async (_e, absolutePath: string): Promise<VaultCruftScanResult> => {
      const ctx = resolveScanContext(absolutePath)
      if ('error' in ctx) return { ok: false, error: ctx.error }
      if (ctx.patterns.length === 0) {
        return { ok: true, matches: [], totalBytes: 0 }
      }
      const matches: VaultCruftMatch[] = []
      let totalBytes = 0
      try {
        await walkFiles(ctx.absDir, (_abs, relPath, size) => {
          if (matchesAny(relPath, ctx.patterns)) {
            matches.push({ relPath, size })
            totalBytes += size
          }
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      return { ok: true, matches, totalBytes }
    }
  )

  ipcMain.handle(
    'vault:clean-cruft',
    async (_e, absolutePath: string): Promise<VaultCruftCleanResult> => {
      const ctx = resolveScanContext(absolutePath)
      if ('error' in ctx) return { ok: false, error: ctx.error }
      if (ctx.patterns.length === 0) {
        return { ok: true, deletedFiles: 0, freedBytes: 0 }
      }
      const toDelete: { abs: string; size: number }[] = []
      try {
        await walkFiles(ctx.absDir, (abs, relPath, size) => {
          if (matchesAny(relPath, ctx.patterns)) {
            toDelete.push({ abs, size })
          }
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      let deletedFiles = 0
      let freedBytes = 0
      for (const f of toDelete) {
        try {
          await fsp.unlink(f.abs)
          deletedFiles++
          freedBytes += f.size
        } catch (err) {
          // Best-effort: log and keep going. A partial clean is still useful.
          console.warn(`[vault] failed to delete ${f.abs}:`, err)
        }
      }
      // Empty parent directories left behind after deletion are tidied up so
      // the file tree doesn't keep ghost folders like `Documentation/`.
      try {
        await pruneEmptyDirs(ctx.absDir)
      } catch (err) {
        console.warn('[vault] prune-empty-dirs failed:', err)
      }
      return { ok: true, deletedFiles, freedBytes }
    }
  )

  ipcMain.handle(
    'vault:open-in-explorer',
    async (_e, absolutePath: string): Promise<VaultOpenResult> => {
      // Only allow opening paths that fall under one of the configured vault roots.
      const cfg = settings.load()
      const resolved = path.resolve(absolutePath)
      const allowed = cfg.vaultPaths.some((root) =>
        resolved.startsWith(path.resolve(root))
      )
      if (!allowed) {
        return { ok: false, error: 'Refusing to open path outside the configured vault roots' }
      }
      try {
        const result = await shell.openPath(resolved)
        if (result) return { ok: false, error: result }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

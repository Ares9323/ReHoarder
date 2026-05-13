import { ipcMain, shell } from 'electron'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { listLocalVault, type LocalVaultEntry } from './vault-local'
import { broadcastDownloads } from './downloads-ipc'
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

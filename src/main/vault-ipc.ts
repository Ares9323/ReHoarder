import { ipcMain, shell } from 'electron'
import * as path from 'node:path'
import { listLocalVault, type LocalVaultEntry } from './vault-local'
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

/**
 * Register `vault:*` IPCs exposing the local-vault scanner to the renderer.
 *
 * Reads `settings.vaultPaths` live on every call so adding/removing paths
 * in Settings reflects without restart.
 */
export function registerVaultIpc(settings: SettingsStore): void {
  ipcMain.handle('vault:list', async (): Promise<VaultListResult> => {
    try {
      const cfg = settings.load()
      const entries = await listLocalVault(cfg.vaultPaths)
      return { ok: true, vaultDirs: cfg.vaultPaths, entries }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[vault] list failed:', msg)
      return { ok: false, error: msg }
    }
  })

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

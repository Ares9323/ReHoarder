import { ipcMain, app, shell } from 'electron'
import * as path from 'node:path'
import { listLocalVault, type LocalVaultEntry } from './vault-local'

export interface VaultListResult {
  ok: boolean
  error?: string
  vaultDir?: string
  entries?: LocalVaultEntry[]
}

export interface VaultOpenResult {
  ok: boolean
  error?: string
}

/**
 * Register `vault:*` IPCs exposing the local-vault scanner to the renderer.
 *
 * For v0c the vault directory is hardcoded to `<userData>/debug-downloads/`
 * (the same path the debug download handler writes to). Once Settings
 * exists, this will read from a user-configured list of vault paths.
 */
export function registerVaultIpc(): void {
  ipcMain.handle('vault:list', async (): Promise<VaultListResult> => {
    try {
      const vaultDir = path.join(app.getPath('userData'), 'debug-downloads')
      const entries = await listLocalVault(vaultDir)
      return { ok: true, vaultDir, entries }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[vault] list failed:', msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle(
    'vault:open-in-explorer',
    async (_e, absolutePath: string): Promise<VaultOpenResult> => {
      // Defense-in-depth: only open paths under the userData tree, never
      // arbitrary disk locations supplied by the renderer.
      const userData = app.getPath('userData')
      const resolved = path.resolve(absolutePath)
      if (!resolved.startsWith(path.resolve(userData))) {
        return { ok: false, error: 'Refusing to open path outside userData' }
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

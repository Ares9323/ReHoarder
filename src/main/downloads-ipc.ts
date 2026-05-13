import { BrowserWindow, ipcMain, shell } from 'electron'
import * as path from 'node:path'
import type { DownloadRow } from './db/downloads-repo'
import type { DownloadsManager } from './downloads-manager'
import type { SettingsStore } from './settings'

export interface DownloadsListResult {
  rows: DownloadRow[]
}

export interface DownloadsActionResult {
  ok: boolean
  error?: string
}

export interface DownloadsEnqueueResult extends DownloadsActionResult {
  id?: string
}

export function registerDownloadsIpc(
  manager: DownloadsManager,
  settings: SettingsStore
): void {
  ipcMain.handle('downloads:list', (): DownloadsListResult => ({ rows: manager.list() }))

  ipcMain.handle(
    'downloads:enqueue',
    (_e, source: string, sourceId: string, title: string): DownloadsEnqueueResult => {
      try {
        const row = manager.enqueue(source, sourceId, title)
        return { ok: true, id: row.id }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('downloads:cancel', (_e, id: string): DownloadsActionResult => {
    const ok = manager.cancel(id)
    return ok ? { ok: true } : { ok: false, error: 'Download cannot be cancelled in its current state' }
  })

  ipcMain.handle('downloads:retry', (_e, id: string): DownloadsActionResult => {
    const ok = manager.retry(id)
    return ok ? { ok: true } : { ok: false, error: 'Only failed/cancelled downloads can be retried' }
  })

  ipcMain.handle('downloads:remove', (_e, id: string): DownloadsActionResult => {
    const ok = manager.remove(id)
    return ok ? { ok: true } : { ok: false, error: 'Cannot remove a running download — cancel it first' }
  })

  ipcMain.handle('downloads:clear-completed', (): { removed: number } => ({
    removed: manager.clearCompleted()
  }))

  ipcMain.handle(
    'downloads:open-in-explorer',
    async (_e, absolutePath: string): Promise<DownloadsActionResult> => {
      // Reveal a download's dest_dir. Guarded by the configured vault roots.
      const cfg = settings.load()
      const resolved = path.resolve(absolutePath)
      const allowed = cfg.vaultPaths.some((root) =>
        resolved.startsWith(path.resolve(root))
      )
      if (!allowed) {
        return { ok: false, error: 'Path is outside the configured vault roots' }
      }
      try {
        const errMsg = await shell.openPath(resolved)
        if (errMsg) return { ok: false, error: errMsg }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

/** Broadcast helper. Sends a snapshot to every currently-open window. */
export function broadcastDownloads(rows: DownloadRow[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('downloads:state-changed', rows)
  }
}

export function broadcastDownloadProgress(_id: string, row: DownloadRow): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('downloads:progress', row)
  }
}

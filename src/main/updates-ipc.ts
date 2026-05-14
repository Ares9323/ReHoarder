import { app, BrowserWindow, ipcMain } from 'electron'
import { UpdateManager, type UpdateInfo } from 'velopack'

/**
 * Where Velopack looks for updates. For ReHoarder the channel is the GitHub
 * Releases of the main repo — `vpk upload github` populates the matching
 * artefacts (`Setup.exe` / `.nupkg` / `RELEASES` index) on each release.
 */
const UPDATE_URL = 'https://github.com/Ares9323/ReHoarder'

export interface UpdateCheckResult {
  ok: boolean
  available: boolean
  error?: string
  currentVersion?: string
  targetVersion?: string
  notes?: string | null
}

export interface UpdateActionResult {
  ok: boolean
  error?: string
}

/**
 * Singleton Velopack manager. Cached so we don't re-instantiate the native
 * binding on every IPC call, and so `download` / `apply` can reference the
 * same `UpdateInfo` that `check` produced.
 */
let manager: UpdateManager | null = null
let pendingUpdate: UpdateInfo | null = null

function getManager(): UpdateManager | null {
  if (!app.isPackaged) {
    // In dev there's no install context — Velopack's locator will fail.
    return null
  }
  if (!manager) {
    manager = new UpdateManager(UPDATE_URL)
  }
  return manager
}

export function registerUpdatesIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('updates:current-version', (): string => {
    const mgr = getManager()
    if (mgr) {
      try {
        return mgr.getCurrentVersion()
      } catch {
        // fall through to package.json
      }
    }
    return app.getVersion()
  })

  ipcMain.handle('updates:check', async (): Promise<UpdateCheckResult> => {
    const mgr = getManager()
    if (!mgr) {
      return {
        ok: true,
        available: false,
        currentVersion: app.getVersion(),
        error: 'Updates are only available in packaged builds.'
      }
    }
    try {
      const currentVersion = mgr.getCurrentVersion()
      const info = await mgr.checkForUpdatesAsync()
      if (!info) {
        pendingUpdate = null
        return { ok: true, available: false, currentVersion }
      }
      pendingUpdate = info
      // `TargetFullRelease` is the asset Velopack would install; we surface
      // its version + notes so the renderer can show a friendly prompt.
      const target = info.TargetFullRelease
      return {
        ok: true,
        available: true,
        currentVersion,
        targetVersion: target?.Version,
        notes: target?.NotesMarkdown ?? null
      }
    } catch (err) {
      return {
        ok: false,
        available: false,
        currentVersion: app.getVersion(),
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle('updates:download', async (): Promise<UpdateActionResult> => {
    const mgr = getManager()
    if (!mgr || !pendingUpdate) {
      return { ok: false, error: 'No pending update — run check first.' }
    }
    try {
      await mgr.downloadUpdateAsync(pendingUpdate, (perc) => {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('updates:download-progress', perc)
        }
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('updates:apply-and-restart', (): UpdateActionResult => {
    const mgr = getManager()
    if (!mgr || !pendingUpdate) {
      return { ok: false, error: 'No pending update — run check + download first.' }
    }
    try {
      // Hands off to the Velopack updater binary, which waits for this
      // process to exit and then swaps in the new build. We call `app.quit`
      // right after so the updater can take over within the 60s window.
      mgr.waitExitThenApplyUpdate(pendingUpdate, false, true)
      app.quit()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

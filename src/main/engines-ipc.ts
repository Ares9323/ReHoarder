import { ipcMain, shell } from 'electron'
import * as path from 'node:path'
import { scanEngines, type EngineInfo } from './engines-local'
import type { SettingsStore } from './settings'

export interface EnginesListResult {
  ok: boolean
  error?: string
  scannedPaths?: string[]
  engines?: EngineInfo[]
}

export interface EnginesOpenResult {
  ok: boolean
  error?: string
}

/**
 * Expose engine scanning to the renderer. The list of base directories
 * comes from `settings.enginePaths`; the renderer never controls which
 * filesystem locations are scanned, which keeps the IPC surface small.
 */
export function registerEnginesIpc(settings: SettingsStore): void {
  ipcMain.handle('engines:list', async (): Promise<EnginesListResult> => {
    try {
      const cfg = settings.load()
      const engines = await scanEngines(cfg.enginePaths)
      return { ok: true, scannedPaths: cfg.enginePaths, engines }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[engines] list failed:', msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle(
    'engines:open-in-explorer',
    async (_e, absolutePath: string): Promise<EnginesOpenResult> => {
      // Defense: only open paths that the current settings declare as engine roots.
      const cfg = settings.load()
      const resolved = path.resolve(absolutePath)
      const allowed = cfg.enginePaths.some((root) =>
        resolved.startsWith(path.resolve(root))
      )
      if (!allowed) {
        return { ok: false, error: 'Path is outside the configured engine roots' }
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

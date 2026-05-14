import { ipcMain, shell } from 'electron'
import * as path from 'node:path'
import { scanEngines, type EngineInfo } from './engines-local'
import {
  listEnginePluginsRich,
  setEnginePluginState,
  type EnginePluginRich,
  type SetPluginStateRequest,
  type SetPluginStateResult
} from './engine-plugins'
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

export interface EnginePluginsListResult {
  ok: boolean
  error?: string
  plugins?: EnginePluginRich[]
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

  /**
   * True iff `absolutePath` lives inside one of the configured engine roots.
   * Used to guard plugin paths so the IPC can't be tricked into editing files
   * outside the user-declared engine install directories.
   */
  function isInsideEngineRoots(absolutePath: string): boolean {
    const cfg = settings.load()
    const resolved = path.resolve(absolutePath)
    return cfg.enginePaths.some((root) => resolved.startsWith(path.resolve(root)))
  }

  ipcMain.handle(
    'engines:list-plugins',
    async (_e, engineRoot: string): Promise<EnginePluginsListResult> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      try {
        const plugins = await listEnginePluginsRich(path.resolve(engineRoot))
        return { ok: true, plugins }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'engines:set-plugin-state',
    async (_e, req: SetPluginStateRequest): Promise<SetPluginStateResult> => {
      if (!isInsideEngineRoots(req.upluginPath)) {
        return { ok: false, error: 'Plugin path is outside the configured engine roots' }
      }
      // .uplugin extension guard: refuse anything else even if it lives under
      // an engine root, so a stray path can't be coerced into rewriting an
      // unrelated config file via this handler.
      if (!req.upluginPath.toLowerCase().endsWith('.uplugin')) {
        return { ok: false, error: 'Target file is not a .uplugin' }
      }
      return await setEnginePluginState(req)
    }
  )

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

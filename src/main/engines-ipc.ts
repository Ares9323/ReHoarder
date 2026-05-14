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
import {
  ensureBaseline,
  readBaseline,
  readBaselineInfo,
  type BaselineInfo
} from './engine-plugin-baselines'
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

export interface BaselineInfoResult extends BaselineInfo {
  ok: boolean
  error?: string
}

export interface RestoreBaselineResult {
  ok: boolean
  error?: string
  /** How many plugins were rewritten back to their baseline state. */
  restored?: number
  /** Failures, one entry per plugin that could not be reverted. */
  failures?: Array<{ name: string; error: string }>
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

  /**
   * Walk up from a plugin's absolute path to the engine install root by
   * stripping the trailing `Engine/Plugins/...` segment. Returns the engine
   * root when it lands inside one of the configured paths, else `null`.
   *
   * Used to take per-engine baselines from a plugin write without having the
   * renderer pass the engine root alongside every state-change call.
   */
  function inferEngineRootFromPluginPath(upluginPath: string): string | null {
    const norm = path.resolve(upluginPath).replace(/\\/g, '/')
    const m = norm.match(/^(.+?)\/Engine\/Plugins\//i)
    if (!m) return null
    const candidate = path.resolve(m[1])
    return isInsideEngineRoots(candidate) ? candidate : null
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
      // Take a Day-0 snapshot of this engine's plugin state before the first
      // write goes through. The capture is idempotent — once a baseline file
      // exists for the engine it's never overwritten, so the "restore" target
      // stays anchored to the very first state ReHoarder saw.
      try {
        const engineRoot = inferEngineRootFromPluginPath(req.upluginPath)
        if (engineRoot) {
          const info = await readBaselineInfo(engineRoot)
          if (!info.exists) {
            const allPlugins = await listEnginePluginsRich(engineRoot)
            await ensureBaseline(
              engineRoot,
              allPlugins.map((p) => ({
                name: p.name,
                upluginPath: p.upluginPath,
                enabledByDefault: p.enabledByDefault,
                installed: p.installed
              }))
            )
          }
        }
      } catch (err) {
        console.warn('[engines] baseline capture failed:', err)
      }
      return await setEnginePluginState(req)
    }
  )

  ipcMain.handle(
    'engines:read-baseline-info',
    async (_e, engineRoot: string): Promise<BaselineInfoResult> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return { ok: false, exists: false, error: 'Engine path is outside the configured engine roots' }
      }
      const info = await readBaselineInfo(path.resolve(engineRoot))
      return { ok: true, ...info }
    }
  )

  ipcMain.handle(
    'engines:restore-baseline',
    async (_e, engineRoot: string): Promise<RestoreBaselineResult> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      const baseline = await readBaseline(path.resolve(engineRoot))
      if (!baseline) {
        return { ok: false, error: 'No baseline found for this engine' }
      }
      let restored = 0
      const failures: Array<{ name: string; error: string }> = []
      for (const entry of baseline.plugins) {
        // Defensive: if the uplugin moved or was deleted, skip rather than
        // creating a phantom file. We only rewrite plugins that still exist.
        if (!isInsideEngineRoots(entry.upluginPath)) {
          failures.push({ name: entry.name, error: 'Plugin path outside engine roots' })
          continue
        }
        const r = await setEnginePluginState({
          upluginPath: entry.upluginPath,
          enabledByDefault: entry.enabledByDefault,
          installed: entry.installed
        })
        if (r.ok) restored++
        else failures.push({ name: entry.name, error: r.error ?? 'unknown error' })
      }
      return { ok: true, restored, failures }
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

import { ipcMain, shell, dialog, app } from 'electron'
import * as path from 'node:path'
import { scanEngines, type EngineInfo } from './engines-local'
import {
  listEnginePluginsRich,
  setEnginePluginState,
  uninstallEnginePlugin,
  type EnginePluginRich,
  type SetPluginStateRequest,
  type SetPluginStateResult,
  type UninstallPluginResult
} from './engine-plugins'
import {
  ensureBaseline,
  readBaseline,
  readBaselineInfo,
  type BaselineInfo
} from './engine-plugin-baselines'
import {
  addPluginToPreset,
  removePluginFromPreset,
  resolvePresetForEngine,
  resolvePresetTargetPath,
  readPresetFile,
  type PluginPresetEntry
} from './engine-plugin-preset'
import {
  applyEditorSettings,
  readEditorSettingsInfo,
  restoreEditorSettings,
  pickMasterTemplate,
  type ApplyEditorSettingsResult,
  type EditorSettingsInfo,
  type MasterTemplateVariant,
  type RestoreEditorSettingsResult
} from './engine-editor-settings'
import { diffLines, type DiffOp } from './text-diff'
import { promises as fsp } from 'node:fs'
import type { AppSettings, SettingsStore } from './settings'

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

export interface PresetResult {
  ok: boolean
  error?: string
  /** Absolute path of the active preset for this engine — null when none configured. */
  path?: string | null
  source?: 'per-engine' | 'global'
  entries?: PluginPresetEntry[]
}

export interface PickFileResult {
  ok: boolean
  /** Cancelled = ok:true + path:null. */
  path?: string | null
  error?: string
}

export interface ApplyPresetToAllResult {
  ok: boolean
  error?: string
  enginesProcessed?: number
  pluginsChanged?: number
  failures?: Array<{ engine: string; name: string; error: string }>
}

export interface PresetMutationResult {
  ok: boolean
  error?: string
  /** Absolute path of the preset file the change landed on. */
  presetPath?: string
  /** Where the resolved path came from. */
  source?: 'per-engine' | 'global'
  /** True when remove actually deleted an entry (false when it wasn't there). */
  removed?: boolean
}

export interface EditorSettingsInfoResult extends EditorSettingsInfo {
  ok: boolean
  error?: string
}

export interface ApplyEditorSettingsToAllResult {
  ok: boolean
  error?: string
  enginesProcessed?: number
  summaries?: Array<{ engine: string; summary: string }>
  failures?: Array<{ engine: string; error: string }>
}

export interface PreviewEditorSettingsResult {
  ok: boolean
  error?: string
  /** Current engine ini content (sentinel header stripped) — left column. */
  current?: string
  /** Proposed merged content with the new sentinel — right column. */
  proposed?: string
  /** Pre-computed diff ops so the renderer only needs to lay them out. */
  diff?: DiffOp[]
  /** Patch summary (counts of overrides / additions / etc). */
  summary?: string
  /** True if a real Apply on the current engine would capture a fresh baseline. */
  willCaptureBaseline?: boolean
  warnings?: string[]
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
    'engines:get-preset',
    async (_e, engineRoot: string): Promise<PresetResult> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      const resolved = await resolvePresetForEngine(path.resolve(engineRoot), settings.load())
      if (resolved === null) {
        return { ok: true, path: null, entries: [] }
      }
      if ('error' in resolved) {
        return { ok: false, error: resolved.error }
      }
      return { ok: true, path: resolved.path, source: resolved.source, entries: resolved.entries }
    }
  )

  ipcMain.handle(
    'engines:set-preset-path-per-engine',
    async (_e, engineRoot: string, presetPath: string | null): Promise<{ ok: boolean; error?: string }> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      const cfg = settings.load()
      const overrides = { ...cfg.pluginPresetPerEngine }
      const key = path.resolve(engineRoot)
      if (presetPath && presetPath.trim().length > 0) {
        overrides[key] = presetPath.trim()
      } else {
        delete overrides[key]
      }
      settings.saveAll({ ...cfg, pluginPresetPerEngine: overrides })
      return { ok: true }
    }
  )

  ipcMain.handle(
    'engines:pick-preset-file',
    async (): Promise<PickFileResult> => {
      // The native picker keeps focus / styling consistent with the OS.
      // The renderer can't reach `dialog` directly, so we proxy it.
      const r = await dialog.showOpenDialog({
        title: 'Pick plugin preset JSON',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (r.canceled || r.filePaths.length === 0) return { ok: true, path: null }
      return { ok: true, path: r.filePaths[0] }
    }
  )

  ipcMain.handle(
    'engines:apply-preset-to-all',
    async (_e, presetPath: string): Promise<ApplyPresetToAllResult> => {
      const cfg = settings.load()
      let entries: PluginPresetEntry[]
      try {
        entries = await readPresetFile(presetPath)
      } catch (err) {
        return {
          ok: false,
          error: `Could not read preset: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      const presetByName = new Map(entries.map((e) => [e.name, e]))
      const failures: Array<{ engine: string; name: string; error: string }> = []
      let enginesProcessed = 0
      let pluginsChanged = 0
      const engines = await scanEngines(cfg.enginePaths)
      for (const engine of engines) {
        enginesProcessed++
        // Snapshot the engine's plugins now so each setPluginState only fires
        // when the preset actually wants a different value (skip no-op writes).
        const plugins = await listEnginePluginsRich(engine.path)
        for (const p of plugins) {
          const wanted = presetByName.get(p.name)
          if (!wanted) continue
          if (
            p.enabledByDefault === wanted.enabledByDefault &&
            p.installed === wanted.installed
          ) {
            continue
          }
          const r = await applyPresetToPluginViaIpc(p, wanted)
          if (r.ok) pluginsChanged++
          else failures.push({ engine: engine.name, name: p.name, error: r.error ?? 'unknown' })
        }
      }
      return { ok: true, enginesProcessed, pluginsChanged, failures }
    }
  )

  ipcMain.handle(
    'engines:editor-settings-info',
    async (_e, engineRoot: string): Promise<EditorSettingsInfoResult> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return {
          ok: false,
          hasSentinel: false,
          hasBackup: false,
          engineIniPath: '',
          masterHash: null,
          error: 'Engine path is outside the configured engine roots'
        }
      }
      const info = await readEditorSettingsInfo(path.resolve(engineRoot))
      return { ok: true, ...info }
    }
  )

  ipcMain.handle(
    'engines:preview-editor-settings',
    async (_e, engineRoot: string): Promise<PreviewEditorSettingsResult> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      const cfg = settings.load()
      const master = cfg.editorSettingsMasterPath?.trim()
      if (!master) {
        return {
          ok: false,
          error: 'No master ini configured — set the path under Settings → Engines.'
        }
      }
      const r = await applyEditorSettings(path.resolve(engineRoot), master, { dryRun: true })
      if (!r.ok) return { ok: false, error: r.error }
      const current = r.currentContent ?? ''
      const proposed = r.proposedContent ?? ''
      return {
        ok: true,
        current,
        proposed,
        diff: diffLines(current, proposed),
        summary: r.summary,
        willCaptureBaseline: r.backupWritten ?? false,
        warnings: r.patch?.warnings ?? []
      }
    }
  )

  ipcMain.handle(
    'engines:apply-editor-settings',
    async (_e, engineRoot: string): Promise<ApplyEditorSettingsResult> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      const cfg = settings.load()
      const master = cfg.editorSettingsMasterPath?.trim()
      if (!master) {
        return {
          ok: false,
          error: 'No master ini configured — set the path under Settings → Engines.'
        }
      }
      return await applyEditorSettings(path.resolve(engineRoot), master)
    }
  )

  ipcMain.handle(
    'engines:restore-editor-settings',
    async (_e, engineRoot: string): Promise<RestoreEditorSettingsResult> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      return await restoreEditorSettings(path.resolve(engineRoot))
    }
  )

  ipcMain.handle(
    'engines:apply-editor-settings-to-all',
    async (): Promise<ApplyEditorSettingsToAllResult> => {
      const cfg = settings.load()
      const master = cfg.editorSettingsMasterPath?.trim()
      if (!master) {
        return {
          ok: false,
          error: 'No master ini configured — set the path under Settings → Engines.'
        }
      }
      const engines = await scanEngines(cfg.enginePaths)
      const summaries: Array<{ engine: string; summary: string }> = []
      const failures: Array<{ engine: string; error: string }> = []
      for (const engine of engines) {
        const r = await applyEditorSettings(engine.path, master)
        if (r.ok && r.summary) summaries.push({ engine: engine.name, summary: r.summary })
        else failures.push({ engine: engine.name, error: r.error ?? 'unknown error' })
      }
      return { ok: true, enginesProcessed: engines.length, summaries, failures }
    }
  )

  ipcMain.handle('engines:pick-master-ini-file', async (): Promise<PickFileResult> => {
    const r = await dialog.showOpenDialog({
      title: 'Pick master BaseEditorPerProjectUserSettings.ini',
      properties: ['openFile'],
      filters: [
        { name: 'INI', extensions: ['ini'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: true, path: null }
    return { ok: true, path: r.filePaths[0] }
  })

  ipcMain.handle(
    'engines:create-master-template',
    async (_e, variant: MasterTemplateVariant = 'basic'): Promise<PickFileResult> => {
      const defaultName =
        variant === 'aresRecommended'
          ? 'BaseEditorPerProjectUserSettings-AresRecommended.ini'
          : 'BaseEditorPerProjectUserSettings.ini'
      const r = await dialog.showSaveDialog({
        title:
          variant === 'aresRecommended'
            ? 'Save Ares-recommended master ini'
            : 'Save sample master ini',
        defaultPath: defaultName,
        filters: [
          { name: 'INI', extensions: ['ini'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (r.canceled || !r.filePath) return { ok: true, path: null }
      try {
        await fsp.writeFile(r.filePath, pickMasterTemplate(variant), 'utf-8')
        return { ok: true, path: r.filePath }
      } catch (err) {
        return {
          ok: false,
          error: `Could not write template: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  )

  ipcMain.handle(
    'engines:open-master-ini-file',
    async (_e, masterPath: string): Promise<EnginesOpenResult> => {
      // Whitelist guard — only honour the currently-configured master path.
      const cfg = settings.load()
      const resolved = path.resolve(masterPath)
      const configured = cfg.editorSettingsMasterPath
        ? path.resolve(cfg.editorSettingsMasterPath)
        : null
      const fold = process.platform === 'win32'
      const same =
        configured !== null &&
        (fold ? configured.toLowerCase() === resolved.toLowerCase() : configured === resolved)
      if (!same) {
        return { ok: false, error: 'Master ini path is not registered in Settings' }
      }
      try {
        const err = await shell.openPath(resolved)
        if (err) return { ok: false, error: err }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'engines:open-preset-file',
    async (_e, presetPath: string): Promise<EnginesOpenResult> => {
      // Whitelist guard: only honour requests for paths the user has actually
      // configured somewhere in settings. Stops a stray IPC call from being
      // coerced into shell-opening an arbitrary file on disk.
      const cfg = settings.load()
      const resolved = path.resolve(presetPath)
      const allowed: string[] = []
      if (cfg.pluginPresetGlobalPath) allowed.push(path.resolve(cfg.pluginPresetGlobalPath))
      for (const v of Object.values(cfg.pluginPresetPerEngine ?? {})) {
        if (v) allowed.push(path.resolve(v))
      }
      const match = allowed.some(
        (p) =>
          (process.platform === 'win32'
            ? p.toLowerCase() === resolved.toLowerCase()
            : p === resolved)
      )
      if (!match) {
        return { ok: false, error: 'Preset path is not registered in Settings' }
      }
      try {
        const err = await shell.openPath(resolved)
        if (err) return { ok: false, error: err }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'engines:preset-add-plugin',
    async (_e, engineRoot: string, entry: PluginPresetEntry): Promise<PresetMutationResult> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      let cfg = settings.load()
      let target = resolvePresetTargetPath(path.resolve(engineRoot), cfg)
      // Zero-config bootstrap: if no preset is configured anywhere, plant a
      // default global preset under userData so the first "Add to config"
      // click just works. The user can move it later (Settings → Engines)
      // or override it per-engine.
      if ('error' in target) {
        const defaultPath = path.join(app.getPath('userData'), 'plugin-preset.json')
        settings.saveAll({ ...cfg, pluginPresetGlobalPath: defaultPath })
        cfg = settings.load()
        target = resolvePresetTargetPath(path.resolve(engineRoot), cfg)
        if ('error' in target) return { ok: false, error: target.error }
      }
      try {
        await addPluginToPreset(target.path, entry)
        return { ok: true, presetPath: target.path, source: target.source }
      } catch (err) {
        return {
          ok: false,
          error: `Could not write preset: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  )

  ipcMain.handle(
    'engines:preset-remove-plugin',
    async (_e, engineRoot: string, name: string): Promise<PresetMutationResult> => {
      if (!isInsideEngineRoots(engineRoot)) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      const target = resolvePresetTargetPath(path.resolve(engineRoot), settings.load())
      if ('error' in target) return { ok: false, error: target.error }
      try {
        const removed = await removePluginFromPreset(target.path, name)
        return { ok: true, presetPath: target.path, source: target.source, removed }
      } catch (err) {
        return {
          ok: false,
          error: `Could not update preset: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  )

  ipcMain.handle(
    'engines:uninstall-plugin',
    async (_e, upluginPath: string): Promise<UninstallPluginResult> => {
      if (!isInsideEngineRoots(upluginPath)) {
        return { ok: false, error: 'Plugin path is outside the configured engine roots' }
      }
      return await uninstallEnginePlugin(upluginPath)
    }
  )

  /**
   * Internal helper for `apply-preset-to-all` — calls into the same path the
   * single-plugin IPC uses so baseline capture + .bak rollback all apply.
   */
  async function applyPresetToPluginViaIpc(
    plugin: EnginePluginRich,
    wanted: PluginPresetEntry
  ): Promise<SetPluginStateResult> {
    const engineRoot = inferEngineRootFromPluginPath(plugin.upluginPath)
    if (engineRoot) {
      try {
        const info = await readBaselineInfo(engineRoot)
        if (!info.exists) {
          const all = await listEnginePluginsRich(engineRoot)
          await ensureBaseline(
            engineRoot,
            all.map((q) => ({
              name: q.name,
              upluginPath: q.upluginPath,
              enabledByDefault: q.enabledByDefault,
              installed: q.installed
            }))
          )
        }
      } catch {
        /* non-fatal */
      }
    }
    return setEnginePluginState({
      upluginPath: plugin.upluginPath,
      enabledByDefault: wanted.enabledByDefault,
      installed: wanted.installed
    })
  }

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

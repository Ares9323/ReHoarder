import { ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { scanProjects, type ProjectInfo } from './projects-local'
import { scanEngines } from './engines-local'
import {
  readDescriptor,
  writeDescriptor,
  listEnginePlugins,
  type EnginePluginInfo
} from './projects-descriptor'
import { installFromVault, type InstallFromVaultResult } from './projects-install'
import { createProjectFromVault, type CreateProjectResult } from './projects-create'
import type { DownloadsRepo } from './db/downloads-repo'
import type { SettingsStore } from './settings'

export interface ProjectsListResult {
  ok: boolean
  error?: string
  scannedPaths?: string[]
  projects?: ProjectInfo[]
}

export interface ProjectsOpenResult {
  ok: boolean
  error?: string
}

export interface ProjectsLaunchResult {
  ok: boolean
  error?: string
  /** Friendly name of the engine actually used (only set on Run, when we resolve it ourselves). */
  engineName?: string
}

export interface ProjectDescriptorResult {
  ok: boolean
  error?: string
  /** Parsed `.uproject` JSON, exactly as it lives on disk. */
  json?: unknown
  /** Last-modified ms; the renderer can re-check before writing to detect outside changes. */
  mtime?: number
}

export interface ProjectDescriptorWriteResult extends ProjectDescriptorResult {
  /** Absolute path of the `.uproject.bak` file that was created before the write (if any). */
  backupPath?: string
}

export interface EnginePluginsResult {
  ok: boolean
  error?: string
  plugins?: EnginePluginInfo[]
}

/** Parse the `.uproject` to read its `EngineAssociation` (`"5.7"` / `"4.27"` / `"{GUID}"` / `""`). */
async function readEngineAssociation(uprojectPath: string): Promise<string> {
  const raw = await fsp.readFile(uprojectPath, 'utf-8')
  const j = JSON.parse(raw) as { EngineAssociation?: string }
  return j.EngineAssociation ?? ''
}

// UnrealVersionSelector's `/game` switch refuses extra args beyond the .uproject
// path ("Invalid command line"), so we don't route Run through UVS. Instead we
// resolve EngineAssociation → engine install ourselves and spawn the editor
// binary directly with `<uproject> -game <user args>`. Launch still goes through
// `shell.openPath`, which uses UVS via the default file association without any
// extra args, so that path is fine.

function guardProjectPath(uprojectPath: string, roots: string[]): string | null {
  const resolved = path.resolve(uprojectPath)
  if (!roots.some((r) => resolved.startsWith(path.resolve(r)))) return null
  return resolved
}

export function registerProjectsIpc(
  settings: SettingsStore,
  downloadsRepo: DownloadsRepo
): void {
  ipcMain.handle('projects:list', async (): Promise<ProjectsListResult> => {
    try {
      const cfg = settings.load()
      const projects = await scanProjects(cfg.projectPaths)
      return { ok: true, scannedPaths: cfg.projectPaths, projects }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[projects] list failed:', msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle(
    'projects:open-in-explorer',
    async (_e, absolutePath: string): Promise<ProjectsOpenResult> => {
      const cfg = settings.load()
      const resolved = path.resolve(absolutePath)
      const allowed = cfg.projectPaths.some((root) =>
        resolved.startsWith(path.resolve(root))
      )
      if (!allowed) {
        return { ok: false, error: 'Path is outside the configured project roots' }
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

  ipcMain.handle(
    'projects:launch-editor',
    async (_e, uprojectPath: string): Promise<ProjectsLaunchResult> => {
      const cfg = settings.load()
      const resolved = guardProjectPath(uprojectPath, cfg.projectPaths)
      if (!resolved) return { ok: false, error: 'Path is outside the configured project roots' }
      // shell.openPath() invokes the default file-association verb, which on Windows
      // is UnrealVersionSelector — it reads `EngineAssociation` from the descriptor
      // and dispatches to the correct editor install, even with several engines around.
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
    'projects:run-game',
    async (_e, uprojectPath: string): Promise<ProjectsLaunchResult> => {
      const cfg = settings.load()
      const resolved = guardProjectPath(uprojectPath, cfg.projectPaths)
      if (!resolved) return { ok: false, error: 'Path is outside the configured project roots' }
      const extraArgs = cfg.gameLaunchParams.filter((s) => s.length > 0)

      let assoc: string
      try {
        assoc = await readEngineAssociation(resolved)
      } catch (err) {
        return {
          ok: false,
          error: `Could not read .uproject: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      if (!assoc) {
        return { ok: false, error: 'The .uproject has no EngineAssociation field' }
      }
      if (assoc.startsWith('{')) {
        return {
          ok: false,
          error: 'Source-build EngineAssociation (GUID) is not yet supported by Run'
        }
      }

      const engines = await scanEngines(cfg.enginePaths)
      const engine = engines.find((e) => e.version.split('.').slice(0, 2).join('.') === assoc)
      if (!engine) {
        return {
          ok: false,
          error: `No engine matching "${assoc}" in the configured engine paths`
        }
      }
      if (!engine.editorExePath) {
        return {
          ok: false,
          error: `Engine ${engine.name} has no editor executable on disk`
        }
      }

      try {
        const proc = spawn(
          engine.editorExePath,
          [resolved, '-game', ...extraArgs],
          { detached: true, stdio: 'ignore' }
        )
        proc.unref()
        return { ok: true, engineName: engine.name }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'projects:read-descriptor',
    async (_e, uprojectPath: string): Promise<ProjectDescriptorResult> => {
      const cfg = settings.load()
      const resolved = guardProjectPath(uprojectPath, cfg.projectPaths)
      if (!resolved) return { ok: false, error: 'Path is outside the configured project roots' }
      try {
        const r = await readDescriptor(resolved)
        return { ok: true, json: r.json, mtime: r.mtime }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'projects:write-descriptor',
    async (
      _e,
      uprojectPath: string,
      content: unknown
    ): Promise<ProjectDescriptorWriteResult> => {
      const cfg = settings.load()
      const resolved = guardProjectPath(uprojectPath, cfg.projectPaths)
      if (!resolved) return { ok: false, error: 'Path is outside the configured project roots' }
      if (!content || typeof content !== 'object') {
        return { ok: false, error: 'Descriptor payload must be a JSON object' }
      }
      try {
        const r = await writeDescriptor(resolved, content)
        return { ok: true, json: r.json, mtime: r.mtime, backupPath: r.backupPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'projects:install-from-vault',
    async (
      _e,
      req: {
        source: string
        sourceId: string
        engineVersion: string | null
        targetPath: string
        kind: 'engine' | 'project'
      }
    ): Promise<InstallFromVaultResult> => {
      const cfg = settings.load()
      const resolved = path.resolve(req.targetPath)
      const allowedRoots =
        req.kind === 'engine' ? cfg.enginePaths : cfg.projectPaths
      const allowed = allowedRoots.some((root) =>
        resolved.startsWith(path.resolve(root))
      )
      if (!allowed) {
        return {
          ok: false,
          error: `Target path is outside the configured ${req.kind} roots`
        }
      }
      return await installFromVault(downloadsRepo, { ...req, targetPath: resolved })
    }
  )

  ipcMain.handle(
    'projects:create-from-vault',
    async (
      _e,
      req: {
        source: string
        sourceId: string
        engineVersion: string | null
        name: string
        parentDir: string
      }
    ): Promise<CreateProjectResult> => {
      const cfg = settings.load()
      const resolvedParent = path.resolve(req.parentDir)
      const allowed = cfg.projectPaths.some((root) =>
        resolvedParent === path.resolve(root) ||
        resolvedParent.startsWith(path.resolve(root) + path.sep)
      )
      if (!allowed) {
        return { ok: false, error: 'Parent path is outside the configured project roots' }
      }
      // Defence: enforce a safe folder name so the user can't path-traverse out.
      const safeName = req.name.replace(/[/\\:*?"<>|]/g, '_').trim()
      if (!safeName) {
        return { ok: false, error: 'Project name is empty after sanitisation' }
      }
      if (/^\d/.test(safeName)) {
        // Unreal generates C++ identifiers from the project name; identifiers
        // can't start with a digit. Catch this here too even though the dialog
        // already blocks it.
        return {
          ok: false,
          error: 'Project name cannot start with a digit (Unreal C++ identifier rules).'
        }
      }
      return await createProjectFromVault(downloadsRepo, {
        ...req,
        name: safeName,
        parentDir: resolvedParent
      })
    }
  )

  ipcMain.handle(
    'projects:list-engine-plugins',
    async (_e, engineRootPath: string): Promise<EnginePluginsResult> => {
      // Defense: only scan inside the configured engine roots — the renderer
      // never gets to walk arbitrary disk locations.
      const cfg = settings.load()
      const resolved = path.resolve(engineRootPath)
      const allowed = cfg.enginePaths.some((root) =>
        resolved.startsWith(path.resolve(root))
      )
      if (!allowed) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      try {
        const plugins = await listEnginePlugins(resolved)
        return { ok: true, plugins }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

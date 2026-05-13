import { ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { scanProjects, type ProjectInfo } from './projects-local'
import { scanEngines } from './engines-local'
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

export function registerProjectsIpc(settings: SettingsStore): void {
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
}

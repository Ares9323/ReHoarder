import { app, ipcMain, shell, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
import {
  addToProject,
  resolvePackContentDir,
  type AddToProjectConflict,
  type AddToProjectResult
} from './projects-add-to'
import { relocatePackIntoProject, type RelocateStage } from './projects-relocate'
import {
  listContentPlugins,
  listContentSubfolders,
  listLoosePackages,
  listTopLevelFolders,
  type AddToProjectDestination,
  type ContentPlugin
} from './projects-relocate-plan'
import { inspectProjectFolder, type InspectProjectFolderResult } from './projects-inspect'
import { setAsTemplate, type SetAsTemplateResult } from './projects-set-as-template'
import {
  cleanupRedirectors,
  cleanBuildArtifacts,
  deepCleanProject,
  resolveEditorCmd,
  resolveEngineForProject,
  type CleanResult,
  type CleanupRedirectorsResult,
  type DeepCleanPreserve
} from './projects-actions'
import { createWindowsShortcut, type CreateShortcutResult } from './engine-actions'
import type { DownloadsRepo } from './db/downloads-repo'
import type { AssetsRepo, AssetSource } from './db/assets-repo'
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

export interface ContentPluginsResult {
  ok: boolean
  error?: string
  plugins?: ContentPlugin[]
}

export interface ContentSubfoldersResult {
  ok: boolean
  error?: string
  /** Existing folders under the mount's content dir, `/`-joined (e.g. `ThirdParty/Env`). */
  folders?: string[]
}

export interface PackTopFoldersResult {
  ok: boolean
  error?: string
  /** Top-level folders of the pack's `Content/` (World Partition side folders excluded). */
  folders?: string[]
  /** `.uasset` / `.umap` package names sitting directly in `Content/`. */
  looseAssets?: string[]
}

/** Pushed on `projects:add-to-progress` while a relocation job runs. */
export interface AddToProgressEvent {
  jobId: string
  stage: RelocateStage
}

/**
 * Shape-check the renderer's destination. `null` = omitted (fast path),
 * `undefined` = malformed. Name rules are enforced later by buildDestination.
 */
function parseDestination(raw: unknown): AddToProjectDestination | null | undefined {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') return undefined
  const d = raw as { mount?: unknown; subfolder?: unknown; rename?: unknown }
  let mount: AddToProjectDestination['mount']
  if (d.mount === 'game') mount = 'game'
  else if (
    d.mount &&
    typeof d.mount === 'object' &&
    typeof (d.mount as { plugin?: unknown }).plugin === 'string'
  ) {
    mount = { plugin: (d.mount as { plugin: string }).plugin }
  } else return undefined
  if (d.subfolder !== undefined && typeof d.subfolder !== 'string') return undefined
  if (d.rename !== undefined && typeof d.rename !== 'string') return undefined
  return { mount, subfolder: d.subfolder, rename: d.rename }
}

/** Resolve the vault-asset folder against the vault roots; `dir: undefined` when not given. */
function resolveVaultAssetDir(
  vaultAssetDir: string | undefined,
  vaultPaths: string[]
): { dir: string | undefined } | { error: string } {
  if (!vaultAssetDir) return { dir: undefined }
  const resolvedAsset = path.resolve(vaultAssetDir)
  const insideVault = vaultPaths.some(
    (root) =>
      resolvedAsset === path.resolve(root) ||
      resolvedAsset.startsWith(path.resolve(root) + path.sep)
  )
  if (!insideVault) return { error: 'Asset path is outside the configured vault roots' }
  return { dir: resolvedAsset }
}

export interface PickDirectoryResult {
  ok: boolean
  /** Cancelled = ok:true + path:null. */
  path?: string | null
  error?: string
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

/**
 * Schedule a deferred `app.quit()` when the user opted in to exit-on-launch.
 * The short delay gives the IPC reply time to flush back to the renderer (so
 * the click handler completes) and the just-launched UVS / editor process
 * time to fully detach before our event loop tears down.
 */
function scheduleExitOnLaunch(settings: SettingsStore): void {
  if (!settings.load().exitOnLaunchUnreal) return
  setTimeout(() => app.quit(), 500)
}

export function registerProjectsIpc(
  settings: SettingsStore,
  downloadsRepo: DownloadsRepo,
  assetsRepo: AssetsRepo
): void {
  ipcMain.handle('projects:list', async (): Promise<ProjectsListResult> => {
    try {
      const cfg = settings.load()
      const projects = await scanProjects(cfg.projectPaths)
      // Splice in the thumbnail URL for ReHoarder-created projects: the
      // `.rehoarder.json` marker traced them back to (source, sourceId), so
      // we replace the local auto-screenshot with the Fab thumbnail when one
      // is available. If the asset row has no image_url we keep whatever the
      // scanner already found (the local AutoScreenshot.png), so the row
      // never *loses* a usable thumbnail by being linked to an asset.
      for (const p of projects) {
        if (!p.rehoarderSource || !p.rehoarderSourceId) continue
        const asset = assetsRepo.findById(
          p.rehoarderSource as AssetSource,
          p.rehoarderSourceId
        )
        if (asset?.imageUrl) p.imageUrl = asset.imageUrl
      }
      return { ok: true, scannedPaths: cfg.projectPaths, projects }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[projects] list failed:', msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('projects:pick-directory', async (): Promise<PickDirectoryResult> => {
    const r = await dialog.showOpenDialog({
      title: 'Pick a folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.load().projectPaths[0]
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: true, path: null }
    return { ok: true, path: r.filePaths[0] }
  })

  ipcMain.handle(
    'projects:inspect-project-folder',
    async (_e, dir: string): Promise<InspectProjectFolderResult> => {
      return await inspectProjectFolder(dir)
    }
  )

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
        scheduleExitOnLaunch(settings)
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
        scheduleExitOnLaunch(settings)
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
        vaultAssetDir?: string
      }
    ): Promise<CreateProjectResult> => {
      const cfg = settings.load()
      const resolvedParent = path.resolve(req.parentDir)
      // No projectPaths containment check here: the user can pick an
      // arbitrary parent folder via the "custom folder" picker. Safety comes
      // from the checks below (safe name, no leading digit, no overwrite).
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
      let resolvedVaultAssetDir: string | undefined
      if (req.vaultAssetDir) {
        const resolved = path.resolve(req.vaultAssetDir)
        const insideVault = cfg.vaultPaths.some(
          (root) =>
            resolved === path.resolve(root) ||
            resolved.startsWith(path.resolve(root) + path.sep)
        )
        if (!insideVault) {
          return { ok: false, error: 'Asset path is outside the configured vault roots' }
        }
        resolvedVaultAssetDir = resolved
      }
      return await createProjectFromVault(downloadsRepo, {
        ...req,
        name: safeName,
        parentDir: resolvedParent,
        vaultAssetDir: resolvedVaultAssetDir
      })
    }
  )

  /** Running relocation jobs, keyed by job id, so `projects:add-to-cancel` can abort them. */
  const addToJobs = new Map<string, AbortController>()

  ipcMain.handle(
    'projects:add-to-project',
    async (
      e,
      req: {
        source: string
        sourceId: string
        engineVersion: string | null
        targetEngineVersion: string | null
        projectDir: string
        conflict: AddToProjectConflict
        vaultAssetDir?: string
        destination?: AddToProjectDestination
        /** Renderer-chosen id so it can cancel and match progress events. */
        jobId?: string
      }
    ): Promise<AddToProjectResult> => {
      const cfg = settings.load()
      const resolved = path.resolve(req.projectDir)
      // No projectPaths containment check here: the user can pick an
      // arbitrary target folder via the "custom folder" picker. The real
      // safety net is addToProject() itself, which refuses folders without
      // a .uproject.
      if (req.conflict !== 'skip' && req.conflict !== 'overwrite') {
        return { ok: false, error: `Unknown conflict mode: ${req.conflict}` }
      }
      const vault = resolveVaultAssetDir(req.vaultAssetDir, cfg.vaultPaths)
      if ('error' in vault) return { ok: false, error: vault.error }
      const destination = parseDestination(req.destination)
      if (destination === undefined) return { ok: false, error: 'Malformed destination' }

      const jobId =
        typeof req.jobId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(req.jobId)
          ? req.jobId
          : randomUUID()
      if (addToJobs.has(jobId)) return { ok: false, error: 'A job with this id is already running' }
      const controller = new AbortController()
      addToJobs.set(jobId, controller)
      const stagesSeen: string[] = []
      const startedAt = Date.now()
      // Every relocation leaves a JSON report under <userData>/relocate/logs,
      // since the scratch project (and Unreal's own log) is deleted afterwards.
      const writeReport = async (result: AddToProjectResult): Promise<void> => {
        if (!destination) return
        try {
          const dir = path.join(app.getPath('userData'), 'relocate', 'logs')
          await fsp.mkdir(dir, { recursive: true })
          const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-')
          const file = path.join(dir, `${stamp}-${jobId}.json`)
          const report = {
            startedAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            projectDir: resolved,
            destination,
            conflict: req.conflict,
            stages: stagesSeen,
            result
          }
          await fsp.writeFile(file, JSON.stringify(report, null, 2), 'utf-8')
          console.warn(
            `[add-to-project] ${result.ok ? 'ok' : result.cancelled ? 'cancelled' : 'failed'}` +
              ` (${stagesSeen.join(' > ') || 'no stage'}), report: ${file}`
          )
        } catch (err) {
          console.warn('[add-to-project] could not write the relocation report:', err)
        }
      }
      try {
        const result = await addToProject(
          downloadsRepo,
          {
            source: req.source,
            sourceId: req.sourceId,
            engineVersion: req.engineVersion,
            targetEngineVersion: req.targetEngineVersion,
            conflict: req.conflict,
            projectDir: resolved,
            vaultAssetDir: vault.dir,
            destination: destination ?? undefined
          },
          ({ sourceContentDir, uprojectPath }) =>
            relocatePackIntoProject(
              {
                jobId,
                sourceContentDir,
                projectDir: resolved,
                uprojectPath,
                conflict: req.conflict,
                destination: destination as AddToProjectDestination
              },
              {
                scratchRoot: path.join(app.getPath('userData'), 'relocate'),
                resolveEditor: async (uproject) => {
                  const r = await resolveEngineForProject(uproject, cfg.enginePaths)
                  if ('error' in r) return r
                  const cmdExe = await resolveEditorCmd(r.engine)
                  if (!cmdExe) {
                    return { error: `Engine ${r.engine.name} has no editor executable on disk` }
                  }
                  return { cmdExe, engineName: r.engine.name, engineRoot: r.engine.path }
                }
              },
              (stage) => {
                stagesSeen.push(stage)
                if (e.sender.isDestroyed()) return
                const ev: AddToProgressEvent = { jobId, stage }
                e.sender.send('projects:add-to-progress', ev)
              },
              controller.signal
            )
        )
        await writeReport(result)
        return result
      } finally {
        addToJobs.delete(jobId)
      }
    }
  )

  ipcMain.handle('projects:add-to-cancel', (_e, jobId: string): { ok: boolean } => {
    const job = addToJobs.get(jobId)
    if (!job) return { ok: false }
    job.abort()
    return { ok: true }
  })

  ipcMain.handle(
    'projects:content-plugins',
    async (_e, projectDir: string): Promise<ContentPluginsResult> => {
      // Read-only listing of `.uplugin` descriptors. Like add-to-project it
      // accepts custom folders, but only real project folders.
      const resolved = path.resolve(projectDir)
      try {
        const entries = await fsp.readdir(resolved)
        if (!entries.some((n) => n.toLowerCase().endsWith('.uproject'))) {
          return { ok: false, error: 'Not an Unreal project folder (no .uproject)' }
        }
        return { ok: true, plugins: await listContentPlugins(resolved) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'projects:content-subfolders',
    async (_e, projectDir: string, plugin: string | null): Promise<ContentSubfoldersResult> => {
      // Existing folders under the chosen mount, for the Subfolder suggestions.
      const resolved = path.resolve(projectDir)
      try {
        const entries = await fsp.readdir(resolved)
        if (!entries.some((n) => n.toLowerCase().endsWith('.uproject'))) {
          return { ok: false, error: 'Not an Unreal project folder (no .uproject)' }
        }
        let contentDir = path.join(resolved, 'Content')
        if (plugin) {
          const match = (await listContentPlugins(resolved)).find((p) => p.name === plugin)
          if (!match) return { ok: false, error: `No content plugin named ${plugin}` }
          contentDir = path.join(match.dir, 'Content')
        }
        return { ok: true, folders: await listContentSubfolders(contentDir, 3) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'projects:pack-top-folders',
    async (
      _e,
      req: {
        source: string
        sourceId: string
        engineVersion: string | null
        vaultAssetDir?: string
      }
    ): Promise<PackTopFoldersResult> => {
      const cfg = settings.load()
      const vault = resolveVaultAssetDir(req.vaultAssetDir, cfg.vaultPaths)
      if ('error' in vault) return { ok: false, error: vault.error }
      const pack = await resolvePackContentDir(downloadsRepo, {
        source: req.source,
        sourceId: req.sourceId,
        engineVersion: req.engineVersion,
        vaultAssetDir: vault.dir
      })
      if ('error' in pack) return { ok: false, error: pack.error }
      const [folders, looseAssets] = await Promise.all([
        listTopLevelFolders(pack.contentDir),
        listLoosePackages(pack.contentDir)
      ])
      return { ok: true, folders, looseAssets }
    }
  )

  ipcMain.handle(
    'projects:set-as-template',
    async (
      _e,
      req: {
        uprojectPath: string
        engineRoot: string
        templateName: string
        displayName: string
        description: string
        categories: string[]
      }
    ): Promise<SetAsTemplateResult> => {
      const cfg = settings.load()
      const resolvedUproject = guardProjectPath(req.uprojectPath, cfg.projectPaths)
      if (!resolvedUproject) {
        return { ok: false, error: 'Project is outside the configured project roots' }
      }
      const resolvedEngine = path.resolve(req.engineRoot)
      const engineAllowed = cfg.enginePaths.some((root) =>
        resolvedEngine.startsWith(path.resolve(root))
      )
      if (!engineAllowed) {
        return { ok: false, error: 'Engine path is outside the configured engine roots' }
      }
      return await setAsTemplate({
        uprojectPath: resolvedUproject,
        engineRoot: resolvedEngine,
        templateName: req.templateName,
        displayName: req.displayName,
        description: req.description,
        categories: req.categories
      })
    }
  )

  ipcMain.handle(
    'projects:cleanup-redirectors',
    async (_e, uprojectPath: string): Promise<CleanupRedirectorsResult> => {
      const cfg = settings.load()
      const resolved = guardProjectPath(uprojectPath, cfg.projectPaths)
      if (!resolved) {
        return {
          ok: false,
          error: 'Path is outside the configured project roots',
          exitCode: null,
          output: ''
        }
      }
      return await cleanupRedirectors(resolved, cfg.enginePaths)
    }
  )

  ipcMain.handle(
    'projects:clean-build-artifacts',
    async (_e, projectDir: string): Promise<CleanResult> => {
      const cfg = settings.load()
      const resolved = path.resolve(projectDir)
      const allowed = cfg.projectPaths.some(
        (root) =>
          resolved === path.resolve(root) ||
          resolved.startsWith(path.resolve(root) + path.sep)
      )
      if (!allowed) {
        return {
          ok: false,
          error: 'Project directory is outside the configured project roots',
          summary: { deletedBytes: 0, deletedPaths: [] }
        }
      }
      return await cleanBuildArtifacts(resolved)
    }
  )

  ipcMain.handle(
    'projects:deep-clean',
    async (
      _e,
      req: { projectDir: string; preserve: DeepCleanPreserve }
    ): Promise<CleanResult> => {
      const cfg = settings.load()
      const resolved = path.resolve(req.projectDir)
      const allowed = cfg.projectPaths.some(
        (root) =>
          resolved === path.resolve(root) ||
          resolved.startsWith(path.resolve(root) + path.sep)
      )
      if (!allowed) {
        return {
          ok: false,
          error: 'Project directory is outside the configured project roots',
          summary: { deletedBytes: 0, deletedPaths: [] }
        }
      }
      return await deepCleanProject(resolved, req.preserve)
    }
  )

  ipcMain.handle(
    'projects:create-shortcut',
    async (_e, uprojectPath: string): Promise<CreateShortcutResult> => {
      const cfg = settings.load()
      const resolved = guardProjectPath(uprojectPath, cfg.projectPaths)
      if (!resolved) {
        return { ok: false, error: 'Path is outside the configured project roots' }
      }
      const projectDir = path.dirname(resolved)
      const projectName = path.basename(resolved, '.uproject')
      return await createWindowsShortcut({
        shortcutName: projectName,
        targetPath: resolved,
        workingDir: projectDir,
        description: `Unreal project: ${projectName}`
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

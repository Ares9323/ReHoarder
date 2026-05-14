import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export type AuthStatus = 'anonymous' | 'authenticated'

export interface AuthStateAnonymous {
  status: 'anonymous'
}
export interface AuthStateAuthenticated {
  status: 'authenticated'
  accountId: string
  displayName: string
}
export type AuthState = AuthStateAnonymous | AuthStateAuthenticated

export interface SubmitCodeResult {
  ok: boolean
  error?: { code: string; message: string }
}

export type AssetSource = 'vault' | 'fab' | 'legacy'
export type AssetSubSource = 'fab-ue' | 'fab-other' | null

export interface AssetRow {
  source: AssetSource
  sourceId: string
  subSource: AssetSubSource
  listingType: string | null
  title: string
  description: string | null
  imageUrl: string | null
  productUrl: string | null
  ownedAt: number | null
  hidden: boolean
  bookmarked: boolean
  raw: string | null
  syncedAt: number
}

export interface LibraryQuery {
  source?: AssetSource
  subSource?: 'fab-ue' | 'fab-other'
  listingType?: string
  category?: string
  search?: string
  includeHidden?: boolean
  onlyHidden?: boolean
  onlyBookmarked?: boolean
}

export interface LibraryListResult {
  assets: AssetRow[]
  countsBySource: Record<string, number>
  availableListingTypes: string[]
  availableCategories: string[]
  lastSync: Record<string, { at: number; status: string; error: string | null }>
}

export type SyncPhase = 'starting' | 'vault' | 'fab' | 'done' | 'error'

export interface SyncProgress {
  phase: SyncPhase
  vaultCount: number
  fabCount: number
  total: number
  error?: string
}

export type ImageSize = 'small' | 'medium' | 'large'

export interface AppSettings {
  loginAtStartup: boolean
  checkVersionAtStartup: boolean
  exitOnLaunchUnreal: boolean
  compilePluginsOnInstall: boolean
  deleteExtraVaultPlatforms: boolean
  downloadThreads: number
  imageSize: ImageSize
  projectPaths: string[]
  enginePaths: string[]
  vaultPaths: string[]
  separateProjectsByPath: boolean
  separateVaultsByPath: boolean
  showVaultThumbnails: boolean
  showProjectThumbnails: boolean
  gameLaunchParams: string[]
}

export interface LocalVaultEntry {
  name: string
  friendlyName: string | null
  /** Thumbnail URL, looked up via the corresponding `assets` row when there's a download record. `null` when no match (legacy folder, hand-copied content). */
  imageUrl: string | null
  path: string
  rootPath: string
  totalBytes: number
  fileCount: number
  lastModified: number
  hasData: boolean
}

export interface VaultListResult {
  ok: boolean
  error?: string
  vaultDirs?: string[]
  entries?: LocalVaultEntry[]
}

export interface VaultOpenResult {
  ok: boolean
  error?: string
}

export interface VaultDeleteResult {
  ok: boolean
  error?: string
  downloadRowsRemoved?: number
}

export interface EngineInfo {
  name: string
  path: string
  version: string
  majorVersion: number
  changelist: number
  branchName: string
  editorExePath: string | null
  hasEditor: boolean
}

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

export interface ProjectInfo {
  name: string
  uprojectPath: string
  projectDir: string
  rootPath: string
  engineAssociation: string
  description: string
  category: string
  hasCode: boolean
  lastModified: number
  rehoarderSource: string | null
  rehoarderSourceId: string | null
  imageUrl: string | null
}

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
  engineName?: string
}

export interface ProjectDescriptorResult {
  ok: boolean
  error?: string
  json?: unknown
  mtime?: number
}

export interface ProjectDescriptorWriteResult extends ProjectDescriptorResult {
  backupPath?: string
}

export interface EnginePluginInfo {
  name: string
  upluginPath: string
  bucket: string
}

export interface EnginePluginsResult {
  ok: boolean
  error?: string
  plugins?: EnginePluginInfo[]
}

export interface InstallFromVaultResult {
  ok: boolean
  error?: string
  destPath?: string
  filesCopied?: number
  bytesCopied?: number
  sourceVaultPath?: string
}

export interface InstallFromVaultRequest {
  source: string
  sourceId: string
  engineVersion: string | null
  targetPath: string
  kind: 'engine' | 'project'
}

export interface CreateProjectRequest {
  source: string
  sourceId: string
  engineVersion: string | null
  name: string
  parentDir: string
}

export interface CreateProjectResult {
  ok: boolean
  error?: string
  projectDir?: string
  uprojectPath?: string
  filesCopied?: number
  bytesCopied?: number
}

export type AddToProjectConflict = 'skip' | 'overwrite'

export interface AddToProjectRequest {
  source: string
  sourceId: string
  engineVersion: string | null
  projectDir: string
  conflict: AddToProjectConflict
}

export interface AddToProjectResult {
  ok: boolean
  error?: string
  sourceContentDir?: string
  destContentDir?: string
  filesCopied?: number
  filesSkipped?: number
  bytesCopied?: number
}

export type DownloadStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface DownloadRow {
  id: string
  source: string
  sourceId: string
  title: string
  status: DownloadStatus
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  currentFile: string | null
  destDir: string | null
  engineVersion: string | null
  installTargetPath: string | null
  buildVersion: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface DownloadEnqueueOptions {
  engineVersion?: string
  installTargetPath?: string
}

export interface DownloadsListResult {
  rows: DownloadRow[]
}

export interface DownloadsEnqueueResult {
  ok: boolean
  error?: string
  id?: string
}

export interface DownloadsActionResult {
  ok: boolean
  error?: string
}

export interface DebugClearLibraryResult {
  ok: boolean
  error?: string
  assetsRemoved?: number
  tagsRemoved?: number
  syncStateRowsReset?: number
}

export interface DebugDownloadSampleAssetResult {
  ok: boolean
  error?: string
  artifactId?: string
  dataDir?: string
  fileCount?: number
  bytesWritten?: number
  durationMs?: number
  firstFiles?: Array<{ filename: string; size: number; skipped: boolean }>
}

export interface DebugFetchSampleManifestResult {
  ok: boolean
  error?: string
  assetId?: string
  artifactId?: string
  manifestHash?: string
  blobBytes?: number
  baseUris?: string[]
  fileCount?: number
  chunkCount?: number
  totalFileSize?: number
  savedBlobPath?: string
  savedJsonPath?: string
}

const api = {
  auth: {
    getState: (): Promise<AuthState> => ipcRenderer.invoke('auth:get-state'),
    startLogin: (): Promise<void> => ipcRenderer.invoke('auth:start-login'),
    submitCode: (code: string): Promise<SubmitCodeResult> =>
      ipcRenderer.invoke('auth:submit-code', code),
    logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
    onStateChanged: (handler: (state: AuthState) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, state: AuthState): void => handler(state)
      ipcRenderer.on('auth:state-changed', listener)
      return () => ipcRenderer.removeListener('auth:state-changed', listener)
    }
  },
  library: {
    list: (query: LibraryQuery): Promise<LibraryListResult> =>
      ipcRenderer.invoke('library:list', query),
    setHidden: (source: AssetSource, sourceId: string, hidden: boolean): Promise<void> =>
      ipcRenderer.invoke('library:set-hidden', source, sourceId, hidden),
    setBookmarked: (source: AssetSource, sourceId: string, bookmarked: boolean): Promise<void> =>
      ipcRenderer.invoke('library:set-bookmarked', source, sourceId, bookmarked),
    sync: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('library:sync'),
    onSyncProgress: (handler: (p: SyncProgress) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: SyncProgress): void => handler(p)
      ipcRenderer.on('library:sync-progress', listener)
      return () => ipcRenderer.removeListener('library:sync-progress', listener)
    },
    onSyncLog: (handler: (line: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, line: string): void => handler(line)
      ipcRenderer.on('library:sync-log', listener)
      return () => ipcRenderer.removeListener('library:sync-log', listener)
    }
  },
  debug: {
    fetchSampleManifest: (assetId: string): Promise<DebugFetchSampleManifestResult> =>
      ipcRenderer.invoke('debug:fetch-sample-manifest', assetId),
    clearLibrary: (
      opts: { sources?: Array<'vault' | 'fab' | 'legacy'> } = {}
    ): Promise<DebugClearLibraryResult> => ipcRenderer.invoke('debug:clear-library', opts),
    downloadSampleAsset: (assetId: string): Promise<DebugDownloadSampleAssetResult> =>
      ipcRenderer.invoke('debug:download-sample-asset', assetId)
  },
  vault: {
    list: (): Promise<VaultListResult> => ipcRenderer.invoke('vault:list'),
    openInExplorer: (absolutePath: string): Promise<VaultOpenResult> =>
      ipcRenderer.invoke('vault:open-in-explorer', absolutePath),
    deleteEntry: (absolutePath: string): Promise<VaultDeleteResult> =>
      ipcRenderer.invoke('vault:delete', absolutePath)
  },
  engines: {
    list: (): Promise<EnginesListResult> => ipcRenderer.invoke('engines:list'),
    openInExplorer: (absolutePath: string): Promise<EnginesOpenResult> =>
      ipcRenderer.invoke('engines:open-in-explorer', absolutePath)
  },
  projects: {
    list: (): Promise<ProjectsListResult> => ipcRenderer.invoke('projects:list'),
    openInExplorer: (absolutePath: string): Promise<ProjectsOpenResult> =>
      ipcRenderer.invoke('projects:open-in-explorer', absolutePath),
    launchEditor: (uprojectPath: string): Promise<ProjectsLaunchResult> =>
      ipcRenderer.invoke('projects:launch-editor', uprojectPath),
    runGame: (uprojectPath: string): Promise<ProjectsLaunchResult> =>
      ipcRenderer.invoke('projects:run-game', uprojectPath),
    readDescriptor: (uprojectPath: string): Promise<ProjectDescriptorResult> =>
      ipcRenderer.invoke('projects:read-descriptor', uprojectPath),
    writeDescriptor: (
      uprojectPath: string,
      content: unknown
    ): Promise<ProjectDescriptorWriteResult> =>
      ipcRenderer.invoke('projects:write-descriptor', uprojectPath, content),
    listEnginePlugins: (engineRootPath: string): Promise<EnginePluginsResult> =>
      ipcRenderer.invoke('projects:list-engine-plugins', engineRootPath),
    installFromVault: (req: InstallFromVaultRequest): Promise<InstallFromVaultResult> =>
      ipcRenderer.invoke('projects:install-from-vault', req),
    createFromVault: (req: CreateProjectRequest): Promise<CreateProjectResult> =>
      ipcRenderer.invoke('projects:create-from-vault', req),
    addToProject: (req: AddToProjectRequest): Promise<AddToProjectResult> =>
      ipcRenderer.invoke('projects:add-to-project', req)
  },
  downloads: {
    list: (): Promise<DownloadsListResult> => ipcRenderer.invoke('downloads:list'),
    enqueue: (
      source: string,
      sourceId: string,
      title: string,
      opts?: DownloadEnqueueOptions
    ): Promise<DownloadsEnqueueResult> =>
      ipcRenderer.invoke('downloads:enqueue', source, sourceId, title, opts ?? {}),
    cancel: (id: string): Promise<DownloadsActionResult> =>
      ipcRenderer.invoke('downloads:cancel', id),
    retry: (id: string): Promise<DownloadsActionResult> =>
      ipcRenderer.invoke('downloads:retry', id),
    remove: (id: string): Promise<DownloadsActionResult> =>
      ipcRenderer.invoke('downloads:remove', id),
    clearCompleted: (): Promise<{ removed: number }> =>
      ipcRenderer.invoke('downloads:clear-completed'),
    openInExplorer: (absolutePath: string): Promise<DownloadsActionResult> =>
      ipcRenderer.invoke('downloads:open-in-explorer', absolutePath),
    onStateChanged: (handler: (rows: DownloadRow[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, rows: DownloadRow[]): void => handler(rows)
      ipcRenderer.on('downloads:state-changed', listener)
      return () => ipcRenderer.removeListener('downloads:state-changed', listener)
    },
    onProgress: (handler: (row: DownloadRow) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, row: DownloadRow): void => handler(row)
      ipcRenderer.on('downloads:progress', listener)
      return () => ipcRenderer.removeListener('downloads:progress', listener)
    }
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (partial: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:set', partial)
  }
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error('contextBridge expose failed:', error)
}

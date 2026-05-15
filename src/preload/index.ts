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

export interface FabFreebie {
  uid: string
  title: string
  imageUrl: string | null
  productUrl: string
  claimed?: boolean
  [key: string]: unknown
}

export interface FreebiesResult {
  ok: boolean
  error?: string
  freebies?: FabFreebie[]
  fetchedAt?: number
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
  skipCruftAtDownload: boolean
  focusFreebiesTabAtStartup: boolean
  cruftPatterns: string[]
  downloadThreads: number
  maxConcurrentDownloads: number
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

export interface VaultCruftMatch {
  relPath: string
  size: number
}

export interface VaultCruftScanResult {
  ok: boolean
  error?: string
  matches?: VaultCruftMatch[]
  totalBytes?: number
}

export interface VaultCruftCleanResult {
  ok: boolean
  error?: string
  deletedFiles?: number
  freedBytes?: number
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

export interface EnginePluginRich {
  name: string
  friendlyName: string
  description: string
  category: string
  versionName: string
  upluginPath: string
  relativePath: string
  bucket: string
  iconUrl: string | null
  enabledByDefault: boolean
  installed: boolean
}

export interface EnginePluginsListResult {
  ok: boolean
  error?: string
  plugins?: EnginePluginRich[]
}

export interface SetPluginStateRequest {
  upluginPath: string
  enabledByDefault?: boolean
  installed?: boolean
}

export interface SetPluginStateResult {
  ok: boolean
  error?: string
  enabledByDefault?: boolean
  installed?: boolean
}

export interface PluginBaselineEntry {
  name: string
  upluginPath: string
  enabledByDefault: boolean
  installed: boolean
}

export interface BaselineInfoResult {
  ok: boolean
  error?: string
  exists: boolean
  createdAt?: number
  pluginCount?: number
  path?: string
  plugins?: PluginBaselineEntry[]
}

export interface RestoreBaselineResult {
  ok: boolean
  error?: string
  restored?: number
  failures?: Array<{ name: string; error: string }>
}

export interface PluginPresetEntry {
  name: string
  enabledByDefault: boolean
  installed: boolean
}

export interface PresetResult {
  ok: boolean
  error?: string
  path?: string | null
  source?: 'per-engine' | 'global'
  entries?: PluginPresetEntry[]
}

export interface PickFileResult {
  ok: boolean
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
  presetPath?: string
  source?: 'per-engine' | 'global'
  removed?: boolean
}

export interface UninstallPluginResult {
  ok: boolean
  error?: string
  pluginDir?: string
}

export interface BuiltInPluginPresetMeta {
  id: string
  label: string
  description: string | null
  pluginCount: number
}

export interface UseBuiltInPluginResult {
  ok: boolean
  error?: string
  path?: string
}

export interface IniPresetMeta {
  id: string
  label: string
  description: string | null
  /** Unit count (chord rules or settings overrides); `null` hides the column. */
  count: number | null
}

export interface UseIniPresetResult {
  ok: boolean
  error?: string
  path?: string
}

export interface EditorSettingsInfo {
  engineIniPath: string
  hasSentinel: boolean
  hasBackup: boolean
  masterHash: string | null
}

export interface EditorSettingsInfoResult extends EditorSettingsInfo {
  ok: boolean
  error?: string
}

export interface ApplyEditorSettingsResult {
  ok: boolean
  error?: string
  engineIniPath?: string
  backupPath?: string
  backupWritten?: boolean
  summary?: string
}

export interface RestoreEditorSettingsResult {
  ok: boolean
  error?: string
  engineIniPath?: string
}

export interface ApplyEditorSettingsToAllResult {
  ok: boolean
  error?: string
  enginesProcessed?: number
  summaries?: Array<{ engine: string; summary: string }>
  failures?: Array<{ engine: string; error: string }>
}

export interface DiffOp {
  kind: 'same' | 'remove' | 'add'
  text: string
  leftLine?: number
  rightLine?: number
}

export interface PreviewEditorSettingsResult {
  ok: boolean
  error?: string
  current?: string
  proposed?: string
  diff?: DiffOp[]
  summary?: string
  willCaptureBaseline?: boolean
  warnings?: string[]
}

export interface KeyBindingsInfo {
  iniPath: string
  hasSentinel: boolean
  hasBackup: boolean
  masterHash: string | null
}

export interface KeyBindingsInfoResult extends KeyBindingsInfo {
  ok: boolean
  error?: string
}

export interface ApplyKeyBindingsResult {
  ok: boolean
  error?: string
  iniPath?: string
  backupPath?: string
  backupWritten?: boolean
  summary?: string
}

export interface RestoreKeyBindingsResult {
  ok: boolean
  error?: string
  iniPath?: string
}

export interface ApplyKeyBindingsToAllResult {
  ok: boolean
  error?: string
  versionsProcessed?: number
  summaries?: Array<{ version: string; summary: string }>
  failures?: Array<{ version: string; error: string }>
}

export interface PreviewKeyBindingsResult {
  ok: boolean
  error?: string
  current?: string
  proposed?: string
  diff?: DiffOp[]
  summary?: string
  willCaptureBaseline?: boolean
  warnings?: string[]
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

export interface SetAsTemplateRequest {
  uprojectPath: string
  engineRoot: string
  templateName: string
  displayName: string
  description: string
  categories: string[]
}

export interface SetAsTemplateResult {
  ok: boolean
  error?: string
  templateDir?: string
  uprojectPath?: string
  filesCopied?: number
  bytesCopied?: number
  mediaCopied?: boolean
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

export interface DebugLauncherCatalogResult {
  ok: boolean
  error?: string
  totalAssets?: number
  engineCandidates?: Array<{
    namespace: string
    catalogItemId: string
    appName: string
    labelName: string
    buildVersion?: string
    title?: string
    categoryPaths?: string[]
  }>
  savedDumpPath?: string
}

export interface DebugEngineDownloadInfoResult {
  ok: boolean
  error?: string
  status?: number
  savedJsonPath?: string
  firstManifestUrl?: string
}

export interface DebugEngineManifestResult {
  ok: boolean
  error?: string
  appName?: string
  buildVersion?: string
  manifestHash?: string
  blobBytes?: number
  fileCount?: number
  chunkCount?: number
  totalFileSize?: number
  installTagsHistogram?: Array<{ tag: string; fileCount: number; bytes: number }>
  baseUris?: string[]
  savedBlobPath?: string
  savedJsonPath?: string
}

export interface EngineSku {
  appName: string
  catalogItemId: string
  namespace: string
  buildVersion: string
  shortVersion: string
}

export interface EngineComponentDescriptor {
  tag: string
  label: string
  defaultEnabled: boolean
  alwaysIncluded: boolean
  isPlatform: boolean
  requires?: string[]
  fileCount: number
  bytes: number
}

export interface EngineInstallPlanSummary {
  appName: string
  buildVersion: string
  manifestHash: string
  totalCompressedBytes: number
  totalDecompressedBytes: number
  components: EngineComponentDescriptor[]
  fetchedAt: number
}

export interface EngineDownloadsListOwnedResult {
  ok: boolean
  error?: string
  engines?: EngineSku[]
}

export interface EngineDownloadsFetchPlanResult {
  ok: boolean
  error?: string
  summary?: EngineInstallPlanSummary
}

export interface EngineDownloadsInstallResult {
  ok: boolean
  error?: string
  downloadId?: string
}

export interface EngineDownloadsPickDirResult {
  ok: boolean
  error?: string
  path?: string | null
}

export interface EngineDownloadsSuggestDirResult {
  ok: boolean
  error?: string
  path?: string
}

export interface EngineDownloadsCheckDirResult {
  ok: boolean
  error?: string
  requiresAdmin: boolean
  isElevated: boolean
  installDir: string
}

export interface EngineDownloadsRelaunchResult {
  ok: boolean
  error?: string
}

export interface EngineInstalledEvent {
  appName: string
  installDir: string
  postInstall: {
    enginePathAdded: string
    enginePathAlreadyConfigured: boolean
    guid: string | null
    registryStatus: 'ok' | 'skipped' | { error: string } | null
  }
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
    listFreebies: (opts: { force?: boolean } = {}): Promise<FreebiesResult> =>
      ipcRenderer.invoke('library:list-freebies', opts),
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
      ipcRenderer.invoke('debug:download-sample-asset', assetId),
    listLauncherCatalog: (): Promise<DebugLauncherCatalogResult> =>
      ipcRenderer.invoke('debug:list-launcher-catalog'),
    fetchEngineDownloadInfo: (args: {
      namespace: string
      catalogItemId: string
      appName: string
      platform?: string
      labelName?: string
    }): Promise<DebugEngineDownloadInfoResult> =>
      ipcRenderer.invoke('debug:fetch-engine-download-info', args),
    fetchEngineManifest: (args: {
      namespace: string
      catalogItemId: string
      appName: string
      platform?: string
      labelName?: string
    }): Promise<DebugEngineManifestResult> =>
      ipcRenderer.invoke('debug:fetch-engine-manifest', args)
  },
  vault: {
    list: (): Promise<VaultListResult> => ipcRenderer.invoke('vault:list'),
    openInExplorer: (absolutePath: string): Promise<VaultOpenResult> =>
      ipcRenderer.invoke('vault:open-in-explorer', absolutePath),
    deleteEntry: (absolutePath: string): Promise<VaultDeleteResult> =>
      ipcRenderer.invoke('vault:delete', absolutePath),
    scanCruft: (absolutePath: string): Promise<VaultCruftScanResult> =>
      ipcRenderer.invoke('vault:scan-cruft', absolutePath),
    cleanCruft: (absolutePath: string): Promise<VaultCruftCleanResult> =>
      ipcRenderer.invoke('vault:clean-cruft', absolutePath)
  },
  engines: {
    list: (): Promise<EnginesListResult> => ipcRenderer.invoke('engines:list'),
    openInExplorer: (absolutePath: string): Promise<EnginesOpenResult> =>
      ipcRenderer.invoke('engines:open-in-explorer', absolutePath),
    listPlugins: (engineRoot: string): Promise<EnginePluginsListResult> =>
      ipcRenderer.invoke('engines:list-plugins', engineRoot),
    setPluginState: (req: SetPluginStateRequest): Promise<SetPluginStateResult> =>
      ipcRenderer.invoke('engines:set-plugin-state', req),
    readBaselineInfo: (engineRoot: string): Promise<BaselineInfoResult> =>
      ipcRenderer.invoke('engines:read-baseline-info', engineRoot),
    restoreBaseline: (engineRoot: string): Promise<RestoreBaselineResult> =>
      ipcRenderer.invoke('engines:restore-baseline', engineRoot),
    getPreset: (engineRoot: string): Promise<PresetResult> =>
      ipcRenderer.invoke('engines:get-preset', engineRoot),
    setPresetPathPerEngine: (
      engineRoot: string,
      presetPath: string | null
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('engines:set-preset-path-per-engine', engineRoot, presetPath),
    pickPresetFile: (): Promise<PickFileResult> =>
      ipcRenderer.invoke('engines:pick-preset-file'),
    listPluginPresetLibrary: (): Promise<{
      ok: boolean
      presets?: BuiltInPluginPresetMeta[]
      error?: string
    }> => ipcRenderer.invoke('engines:list-plugin-preset-library'),
    usePluginPresetFromLibrary: (id: string): Promise<UseBuiltInPluginResult> =>
      ipcRenderer.invoke('engines:use-plugin-preset-from-library', id),
    applyPresetToAll: (presetPath: string): Promise<ApplyPresetToAllResult> =>
      ipcRenderer.invoke('engines:apply-preset-to-all', presetPath),
    presetAddPlugin: (engineRoot: string, entry: PluginPresetEntry): Promise<PresetMutationResult> =>
      ipcRenderer.invoke('engines:preset-add-plugin', engineRoot, entry),
    presetRemovePlugin: (engineRoot: string, name: string): Promise<PresetMutationResult> =>
      ipcRenderer.invoke('engines:preset-remove-plugin', engineRoot, name),
    uninstallPlugin: (upluginPath: string): Promise<UninstallPluginResult> =>
      ipcRenderer.invoke('engines:uninstall-plugin', upluginPath),
    openPresetFile: (presetPath: string): Promise<EnginesOpenResult> =>
      ipcRenderer.invoke('engines:open-preset-file', presetPath),
    editorSettingsInfo: (engineRoot: string): Promise<EditorSettingsInfoResult> =>
      ipcRenderer.invoke('engines:editor-settings-info', engineRoot),
    applyEditorSettings: (engineRoot: string): Promise<ApplyEditorSettingsResult> =>
      ipcRenderer.invoke('engines:apply-editor-settings', engineRoot),
    previewEditorSettings: (engineRoot: string): Promise<PreviewEditorSettingsResult> =>
      ipcRenderer.invoke('engines:preview-editor-settings', engineRoot),
    restoreEditorSettings: (engineRoot: string): Promise<RestoreEditorSettingsResult> =>
      ipcRenderer.invoke('engines:restore-editor-settings', engineRoot),
    applyEditorSettingsToAll: (): Promise<ApplyEditorSettingsToAllResult> =>
      ipcRenderer.invoke('engines:apply-editor-settings-to-all'),
    pickMasterIniFile: (): Promise<PickFileResult> =>
      ipcRenderer.invoke('engines:pick-master-ini-file'),
    listEditorSettingsPresetLibrary: (): Promise<{
      ok: boolean
      presets?: IniPresetMeta[]
      error?: string
    }> => ipcRenderer.invoke('engines:list-editor-settings-preset-library'),
    useEditorSettingsPresetFromLibrary: (id: string): Promise<UseIniPresetResult> =>
      ipcRenderer.invoke('engines:use-editor-settings-preset-from-library', id),
    openMasterIniFile: (masterPath: string): Promise<EnginesOpenResult> =>
      ipcRenderer.invoke('engines:open-master-ini-file', masterPath),
    keybindingsInfo: (engineRoot: string): Promise<KeyBindingsInfoResult> =>
      ipcRenderer.invoke('engines:keybindings-info', engineRoot),
    previewKeybindings: (engineRoot: string): Promise<PreviewKeyBindingsResult> =>
      ipcRenderer.invoke('engines:preview-keybindings', engineRoot),
    applyKeybindings: (engineRoot: string): Promise<ApplyKeyBindingsResult> =>
      ipcRenderer.invoke('engines:apply-keybindings', engineRoot),
    restoreKeybindings: (engineRoot: string): Promise<RestoreKeyBindingsResult> =>
      ipcRenderer.invoke('engines:restore-keybindings', engineRoot),
    applyKeybindingsToAll: (): Promise<ApplyKeyBindingsToAllResult> =>
      ipcRenderer.invoke('engines:apply-keybindings-to-all'),
    pickKeybindingsFile: (): Promise<PickFileResult> =>
      ipcRenderer.invoke('engines:pick-keybindings-file'),
    listKeybindingsPresetLibrary: (): Promise<{
      ok: boolean
      presets?: IniPresetMeta[]
      error?: string
    }> => ipcRenderer.invoke('engines:list-keybindings-preset-library'),
    useKeybindingsPresetFromLibrary: (id: string): Promise<UseIniPresetResult> =>
      ipcRenderer.invoke('engines:use-keybindings-preset-from-library', id),
    openKeybindingsFile: (masterPath: string): Promise<EnginesOpenResult> =>
      ipcRenderer.invoke('engines:open-keybindings-file', masterPath)
  },
  engineDownloads: {
    listOwned: (
      opts: { forceRefresh?: boolean } = {}
    ): Promise<EngineDownloadsListOwnedResult> =>
      ipcRenderer.invoke('engine-downloads:list-owned', opts),
    fetchInstallPlan: (sku: {
      namespace: string
      catalogItemId: string
      appName: string
    }): Promise<EngineDownloadsFetchPlanResult> =>
      ipcRenderer.invoke('engine-downloads:fetch-install-plan', sku),
    suggestInstallDir: (appName: string): Promise<EngineDownloadsSuggestDirResult> =>
      ipcRenderer.invoke('engine-downloads:suggest-install-dir', appName),
    checkInstallDir: (installDir: string): Promise<EngineDownloadsCheckDirResult> =>
      ipcRenderer.invoke('engine-downloads:check-install-dir', installDir),
    relaunchElevated: (): Promise<EngineDownloadsRelaunchResult> =>
      ipcRenderer.invoke('engine-downloads:relaunch-elevated'),
    pickInstallDir: (defaultPath: string | null): Promise<EngineDownloadsPickDirResult> =>
      ipcRenderer.invoke('engine-downloads:pick-install-dir', defaultPath),
    install: (args: {
      sku: { namespace: string; catalogItemId: string; appName: string; shortVersion: string }
      selectedTags: string[]
      installDir: string
    }): Promise<EngineDownloadsInstallResult> =>
      ipcRenderer.invoke('engine-downloads:install', args),
    onInstalled: (
      handler: (info: EngineInstalledEvent) => void
    ): (() => void) => {
      const listener = (_e: IpcRendererEvent, info: EngineInstalledEvent): void =>
        handler(info)
      ipcRenderer.on('engine-downloads:installed', listener)
      return () => ipcRenderer.removeListener('engine-downloads:installed', listener)
    }
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
      ipcRenderer.invoke('projects:add-to-project', req),
    setAsTemplate: (req: SetAsTemplateRequest): Promise<SetAsTemplateResult> =>
      ipcRenderer.invoke('projects:set-as-template', req),
    cleanupRedirectors: (uprojectPath: string): Promise<ProjectCleanupRedirectorsResult> =>
      ipcRenderer.invoke('projects:cleanup-redirectors', uprojectPath),
    cleanBuildArtifacts: (projectDir: string): Promise<ProjectCleanResult> =>
      ipcRenderer.invoke('projects:clean-build-artifacts', projectDir),
    deepClean: (req: {
      projectDir: string
      preserve: DeepCleanPreserve
    }): Promise<ProjectCleanResult> => ipcRenderer.invoke('projects:deep-clean', req)
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
  },
  updates: {
    currentVersion: (): Promise<string> => ipcRenderer.invoke('updates:current-version'),
    check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
    getPendingState: (): Promise<UpdateCheckResult> =>
      ipcRenderer.invoke('updates:get-pending-state'),
    download: (): Promise<UpdateActionResult> => ipcRenderer.invoke('updates:download'),
    applyAndRestart: (): Promise<UpdateActionResult> =>
      ipcRenderer.invoke('updates:apply-and-restart'),
    onDownloadProgress: (handler: (perc: number) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, perc: number): void => handler(perc)
      ipcRenderer.on('updates:download-progress', listener)
      return () => ipcRenderer.removeListener('updates:download-progress', listener)
    },
    onAvailable: (
      handler: (info: {
        available: boolean
        currentVersion: string
        targetVersion?: string
        notes?: string | null
      }) => void
    ): (() => void) => {
      const listener = (_e: IpcRendererEvent, info: Parameters<typeof handler>[0]): void =>
        handler(info)
      ipcRenderer.on('updates:available', listener)
      return () => ipcRenderer.removeListener('updates:available', listener)
    }
  }
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error('contextBridge expose failed:', error)
}

import { ElectronAPI } from '@electron-toolkit/preload'

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

export interface AuthApi {
  getState(): Promise<AuthState>
  startLogin(): Promise<void>
  submitCode(code: string): Promise<SubmitCodeResult>
  logout(): Promise<void>
  onStateChanged(handler: (state: AuthState) => void): () => void
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

export interface LibraryApi {
  list(query: LibraryQuery): Promise<LibraryListResult>
  setHidden(source: AssetSource, sourceId: string, hidden: boolean): Promise<void>
  setBookmarked(source: AssetSource, sourceId: string, bookmarked: boolean): Promise<void>
  sync(): Promise<{ ok: boolean; error?: string }>
  listFreebies(opts?: { force?: boolean }): Promise<FreebiesResult>
  onSyncProgress(handler: (p: SyncProgress) => void): () => void
  onSyncLog(handler: (line: string) => void): () => void
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

export interface DebugApi {
  fetchSampleManifest(assetId: string): Promise<DebugFetchSampleManifestResult>
  clearLibrary(opts?: {
    sources?: Array<'vault' | 'fab' | 'legacy'>
  }): Promise<DebugClearLibraryResult>
  downloadSampleAsset(assetId: string): Promise<DebugDownloadSampleAssetResult>
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

export interface SettingsApi {
  get(): Promise<AppSettings>
  set(partial: Partial<AppSettings>): Promise<AppSettings>
}

export interface LocalVaultEntry {
  name: string
  friendlyName: string | null
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

export interface VaultApi {
  list(): Promise<VaultListResult>
  openInExplorer(absolutePath: string): Promise<VaultOpenResult>
  deleteEntry(absolutePath: string): Promise<VaultDeleteResult>
  scanCruft(absolutePath: string): Promise<VaultCruftScanResult>
  cleanCruft(absolutePath: string): Promise<VaultCruftCleanResult>
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

export interface EnginesApi {
  list(): Promise<EnginesListResult>
  openInExplorer(absolutePath: string): Promise<EnginesOpenResult>
  listPlugins(engineRoot: string): Promise<EnginePluginsListResult>
  setPluginState(req: SetPluginStateRequest): Promise<SetPluginStateResult>
  readBaselineInfo(engineRoot: string): Promise<BaselineInfoResult>
  restoreBaseline(engineRoot: string): Promise<RestoreBaselineResult>
  getPreset(engineRoot: string): Promise<PresetResult>
  setPresetPathPerEngine(
    engineRoot: string,
    presetPath: string | null
  ): Promise<{ ok: boolean; error?: string }>
  pickPresetFile(): Promise<PickFileResult>
  applyPresetToAll(presetPath: string): Promise<ApplyPresetToAllResult>
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

export interface InstallFromVaultRequest {
  source: string
  sourceId: string
  engineVersion: string | null
  targetPath: string
  kind: 'engine' | 'project'
}

export interface InstallFromVaultResult {
  ok: boolean
  error?: string
  destPath?: string
  filesCopied?: number
  bytesCopied?: number
  sourceVaultPath?: string
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

export interface ProjectsApi {
  list(): Promise<ProjectsListResult>
  openInExplorer(absolutePath: string): Promise<ProjectsOpenResult>
  launchEditor(uprojectPath: string): Promise<ProjectsLaunchResult>
  runGame(uprojectPath: string): Promise<ProjectsLaunchResult>
  readDescriptor(uprojectPath: string): Promise<ProjectDescriptorResult>
  writeDescriptor(uprojectPath: string, content: unknown): Promise<ProjectDescriptorWriteResult>
  listEnginePlugins(engineRootPath: string): Promise<EnginePluginsResult>
  installFromVault(req: InstallFromVaultRequest): Promise<InstallFromVaultResult>
  createFromVault(req: CreateProjectRequest): Promise<CreateProjectResult>
  addToProject(req: AddToProjectRequest): Promise<AddToProjectResult>
  setAsTemplate(req: SetAsTemplateRequest): Promise<SetAsTemplateResult>
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

export interface DownloadsApi {
  list(): Promise<DownloadsListResult>
  enqueue(
    source: string,
    sourceId: string,
    title: string,
    opts?: DownloadEnqueueOptions
  ): Promise<DownloadsEnqueueResult>
  cancel(id: string): Promise<DownloadsActionResult>
  retry(id: string): Promise<DownloadsActionResult>
  remove(id: string): Promise<DownloadsActionResult>
  clearCompleted(): Promise<{ removed: number }>
  openInExplorer(absolutePath: string): Promise<DownloadsActionResult>
  onStateChanged(handler: (rows: DownloadRow[]) => void): () => void
  onProgress(handler: (row: DownloadRow) => void): () => void
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

export interface UpdatesApi {
  currentVersion(): Promise<string>
  check(): Promise<UpdateCheckResult>
  download(): Promise<UpdateActionResult>
  applyAndRestart(): Promise<UpdateActionResult>
  onDownloadProgress(handler: (perc: number) => void): () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      auth: AuthApi
      library: LibraryApi
      debug: DebugApi
      vault: VaultApi
      engines: EnginesApi
      projects: ProjectsApi
      downloads: DownloadsApi
      settings: SettingsApi
      updates: UpdatesApi
    }
  }
}

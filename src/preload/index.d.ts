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

export interface AssetRow {
  source: AssetSource
  sourceId: string
  title: string
  description: string | null
  imageUrl: string | null
  productUrl: string | null
  ownedAt: number | null
  hidden: boolean
  raw: string | null
  syncedAt: number
}

export interface LibraryQuery {
  source?: AssetSource
  search?: string
  includeHidden?: boolean
}

export interface LibraryListResult {
  assets: AssetRow[]
  countsBySource: Record<string, number>
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

export interface LibraryApi {
  list(query: LibraryQuery): Promise<LibraryListResult>
  setHidden(source: AssetSource, sourceId: string, hidden: boolean): Promise<void>
  sync(): Promise<{ ok: boolean; error?: string }>
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
  downloadThreads: number
  imageSize: ImageSize
  projectPaths: string[]
  enginePaths: string[]
  vaultPaths: string[]
}

export interface SettingsApi {
  get(): Promise<AppSettings>
  set(partial: Partial<AppSettings>): Promise<AppSettings>
}

export interface LocalVaultEntry {
  name: string
  path: string
  totalBytes: number
  fileCount: number
  lastModified: number
  hasData: boolean
}

export interface VaultListResult {
  ok: boolean
  error?: string
  vaultDir?: string
  entries?: LocalVaultEntry[]
}

export interface VaultOpenResult {
  ok: boolean
  error?: string
}

export interface VaultApi {
  list(): Promise<VaultListResult>
  openInExplorer(absolutePath: string): Promise<VaultOpenResult>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      auth: AuthApi
      library: LibraryApi
      debug: DebugApi
      vault: VaultApi
      settings: SettingsApi
    }
  }
}

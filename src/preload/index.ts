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
      ipcRenderer.invoke('vault:open-in-explorer', absolutePath)
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

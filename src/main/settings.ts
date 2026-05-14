import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import type { KvStore } from './db/kv'

export type ImageSize = 'small' | 'medium' | 'large'

export interface AppSettings {
  /** Auto-refresh Epic session on app startup so the user lands authenticated. */
  loginAtStartup: boolean
  /** Check for ReHoarder app updates at startup (requires updater integration). */
  checkVersionAtStartup: boolean
  /** When the user launches an Unreal Editor / project from inside the app, quit ReHoarder. */
  exitOnLaunchUnreal: boolean
  /** Run `RunUAT BuildPlugin` after copying a code plugin into the engine. */
  compilePluginsOnInstall: boolean
  /** Skip `/Binaries/<otherPlatform>/` and `/Intermediates/Build/<otherPlatform>/` at download time. */
  deleteExtraVaultPlatforms: boolean
  /** Master switch for the cruft-skip behaviour at download time. When off, neither defaults nor `cruftPatterns` are applied. */
  skipCruftAtDownload: boolean
  /** When true, the renderer fetches Fab freebies on app launch and switches the active tab to Freebies if any are unclaimed. */
  focusFreebiesTabAtStartup: boolean
  /** Extra glob patterns appended to the built-in cruft list (cruft-filter syntax). One per line in the UI. */
  cruftPatterns: string[]
  /** Worker pool size for chunk downloads within a single asset (1-64). */
  downloadThreads: number
  /** How many separate asset downloads can run from the queue at once (1-8). */
  maxConcurrentDownloads: number
  /** Asset card size preset in the library grid. */
  imageSize: ImageSize
  /** Filesystem paths scanned for *.uproject files (one per line in the UI). */
  projectPaths: string[]
  /** Filesystem paths scanned for `UE_*` engine installations. */
  enginePaths: string[]
  /** Where downloads are written. The first existing path is used; new entries are created on demand. */
  vaultPaths: string[]
  /** Render the Projects tab with one table per configured root path instead of a single combined table. */
  separateProjectsByPath: boolean
  /** Render the Vault tab with one table per configured root path instead of a single combined table. */
  separateVaultsByPath: boolean
  /** Show the asset thumbnail (from Fab) next to each Vault entry. Off makes the list more compact / faster on big vaults. */
  showVaultThumbnails: boolean
  /** Show the source-asset thumbnail next to each Project entry (only available for projects created via ReHoarder, where we stamp a `.rehoarder.json` next to the .uproject). */
  showProjectThumbnails: boolean
  /** Extra args appended after `-game` when the user clicks "Run" on a project. `-game` is always added implicitly. */
  gameLaunchParams: string[]
  /** Absolute path to a JSON file used as the engine-wide plugin preset (format: `{plugins:[{name, enabledByDefault, installed}]}`). Empty string disables the fallback. */
  pluginPresetGlobalPath: string
  /** Per-engine override map (engineRoot → preset path). Takes precedence over `pluginPresetGlobalPath` when an entry is present. */
  pluginPresetPerEngine: Record<string, string>
  /** Absolute path to a master `BaseEditorPerProjectUserSettings.ini` that the user maintains; applied to every engine's Editor settings on demand. Empty disables the feature. */
  editorSettingsMasterPath: string
}

const SETTINGS_KEY = 'app_settings_v1'

const MIN_THREADS = 1
const MAX_THREADS = 64
const MIN_CONCURRENT_DOWNLOADS = 1
const MAX_CONCURRENT_DOWNLOADS = 8

function defaultProjectPaths(): string[] {
  if (process.platform === 'win32') {
    return [path.join(app.getPath('documents'), 'Unreal Projects')]
  }
  if (process.platform === 'darwin') {
    return [path.join(os.homedir(), 'Documents', 'Unreal Projects')]
  }
  return [path.join(os.homedir(), 'Unreal Projects')]
}

function defaultEnginePaths(): string[] {
  if (process.platform === 'win32') {
    return ['C:\\Program Files\\Epic Games\\']
  }
  if (process.platform === 'darwin') {
    return ['/Users/Shared/Epic Games/']
  }
  return [path.join(os.homedir(), 'UnrealEngine') + path.sep]
}

function defaultVaultPaths(): string[] {
  return [path.join(app.getPath('userData'), 'debug-downloads')]
}

export function defaultSettings(): AppSettings {
  return {
    loginAtStartup: true,
    checkVersionAtStartup: true,
    exitOnLaunchUnreal: false,
    compilePluginsOnInstall: process.platform === 'linux',
    deleteExtraVaultPlatforms: false,
    skipCruftAtDownload: true,
    focusFreebiesTabAtStartup: false,
    cruftPatterns: [],
    downloadThreads: 16,
    maxConcurrentDownloads: 2,
    imageSize: 'small',
    projectPaths: defaultProjectPaths(),
    enginePaths: defaultEnginePaths(),
    vaultPaths: defaultVaultPaths(),
    separateProjectsByPath: false,
    separateVaultsByPath: false,
    showVaultThumbnails: true,
    showProjectThumbnails: true,
    gameLaunchParams: ['-log', '-windowed', '-ResX=1280', '-ResY=720'],
    pluginPresetGlobalPath: '',
    pluginPresetPerEngine: {},
    editorSettingsMasterPath: ''
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

function sanitizePaths(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return arr
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function sanitizeImageSize(v: unknown): ImageSize {
  return v === 'medium' || v === 'large' ? v : 'small'
}

/**
 * Merge a possibly partial / untrusted payload onto the defaults, clamping
 * numeric ranges and dropping malformed fields. Used when loading from disk
 * (forward/backward compat) and when receiving a `setAll()` payload from the
 * renderer.
 */
export function mergeSettings(partial: Partial<AppSettings> | null | undefined): AppSettings {
  const d = defaultSettings()
  if (!partial || typeof partial !== 'object') return d
  return {
    loginAtStartup: typeof partial.loginAtStartup === 'boolean' ? partial.loginAtStartup : d.loginAtStartup,
    checkVersionAtStartup:
      typeof partial.checkVersionAtStartup === 'boolean' ? partial.checkVersionAtStartup : d.checkVersionAtStartup,
    exitOnLaunchUnreal:
      typeof partial.exitOnLaunchUnreal === 'boolean' ? partial.exitOnLaunchUnreal : d.exitOnLaunchUnreal,
    compilePluginsOnInstall:
      typeof partial.compilePluginsOnInstall === 'boolean'
        ? partial.compilePluginsOnInstall
        : d.compilePluginsOnInstall,
    deleteExtraVaultPlatforms:
      typeof partial.deleteExtraVaultPlatforms === 'boolean'
        ? partial.deleteExtraVaultPlatforms
        : d.deleteExtraVaultPlatforms,
    skipCruftAtDownload:
      typeof partial.skipCruftAtDownload === 'boolean'
        ? partial.skipCruftAtDownload
        : d.skipCruftAtDownload,
    focusFreebiesTabAtStartup:
      typeof partial.focusFreebiesTabAtStartup === 'boolean'
        ? partial.focusFreebiesTabAtStartup
        : d.focusFreebiesTabAtStartup,
    cruftPatterns: partial.cruftPatterns ? sanitizePaths(partial.cruftPatterns) : d.cruftPatterns,
    downloadThreads:
      typeof partial.downloadThreads === 'number'
        ? clamp(partial.downloadThreads, MIN_THREADS, MAX_THREADS)
        : d.downloadThreads,
    maxConcurrentDownloads:
      typeof partial.maxConcurrentDownloads === 'number'
        ? clamp(partial.maxConcurrentDownloads, MIN_CONCURRENT_DOWNLOADS, MAX_CONCURRENT_DOWNLOADS)
        : d.maxConcurrentDownloads,
    imageSize: partial.imageSize ? sanitizeImageSize(partial.imageSize) : d.imageSize,
    projectPaths: partial.projectPaths ? sanitizePaths(partial.projectPaths) : d.projectPaths,
    enginePaths: partial.enginePaths ? sanitizePaths(partial.enginePaths) : d.enginePaths,
    vaultPaths: partial.vaultPaths ? sanitizePaths(partial.vaultPaths) : d.vaultPaths,
    separateProjectsByPath:
      typeof partial.separateProjectsByPath === 'boolean'
        ? partial.separateProjectsByPath
        : d.separateProjectsByPath,
    separateVaultsByPath:
      typeof partial.separateVaultsByPath === 'boolean'
        ? partial.separateVaultsByPath
        : d.separateVaultsByPath,
    showVaultThumbnails:
      typeof partial.showVaultThumbnails === 'boolean'
        ? partial.showVaultThumbnails
        : d.showVaultThumbnails,
    showProjectThumbnails:
      typeof partial.showProjectThumbnails === 'boolean'
        ? partial.showProjectThumbnails
        : d.showProjectThumbnails,
    gameLaunchParams: partial.gameLaunchParams
      ? sanitizePaths(partial.gameLaunchParams)
      : d.gameLaunchParams,
    pluginPresetGlobalPath:
      typeof partial.pluginPresetGlobalPath === 'string'
        ? partial.pluginPresetGlobalPath.trim()
        : d.pluginPresetGlobalPath,
    pluginPresetPerEngine: sanitizeStringRecord(partial.pluginPresetPerEngine) ?? d.pluginPresetPerEngine,
    editorSettingsMasterPath:
      typeof partial.editorSettingsMasterPath === 'string'
        ? partial.editorSettingsMasterPath.trim()
        : d.editorSettingsMasterPath
  }
}

/**
 * Sanitise a `Record<string, string>` from an untrusted payload. Strips
 * non-string keys / values and trims whitespace. Returns `null` when the
 * input isn't a plain object so the caller can fall back to the default.
 */
function sanitizeStringRecord(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === 'string' && k.length > 0 && typeof v === 'string' && v.trim().length > 0) {
      out[k] = v.trim()
    }
  }
  return out
}

/**
 * Thin wrapper over the KV store. Reads/writes the entire `AppSettings`
 * blob as one JSON document keyed under `app_settings_v1` — keeps the
 * SQLite footprint trivial and atomic.
 */
export class SettingsStore {
  constructor(private readonly kv: KvStore) {}

  load(): AppSettings {
    const raw = this.kv.getJson<Partial<AppSettings>>(SETTINGS_KEY)
    return mergeSettings(raw)
  }

  saveAll(s: Partial<AppSettings>): AppSettings {
    const merged = mergeSettings(s)
    this.kv.setJson(SETTINGS_KEY, merged)
    return merged
  }
}

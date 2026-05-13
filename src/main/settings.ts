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
  /** Worker pool size for chunk downloads (1-64). */
  downloadThreads: number
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
  /** Extra args appended after `-game` when the user clicks "Run" on a project. `-game` is always added implicitly. */
  gameLaunchParams: string[]
}

const SETTINGS_KEY = 'app_settings_v1'

const MIN_THREADS = 1
const MAX_THREADS = 64

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
    downloadThreads: 16,
    imageSize: 'small',
    projectPaths: defaultProjectPaths(),
    enginePaths: defaultEnginePaths(),
    vaultPaths: defaultVaultPaths(),
    separateProjectsByPath: false,
    gameLaunchParams: ['-log', '-windowed', '-ResX=1280', '-ResY=720']
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
    downloadThreads:
      typeof partial.downloadThreads === 'number'
        ? clamp(partial.downloadThreads, MIN_THREADS, MAX_THREADS)
        : d.downloadThreads,
    imageSize: partial.imageSize ? sanitizeImageSize(partial.imageSize) : d.imageSize,
    projectPaths: partial.projectPaths ? sanitizePaths(partial.projectPaths) : d.projectPaths,
    enginePaths: partial.enginePaths ? sanitizePaths(partial.enginePaths) : d.enginePaths,
    vaultPaths: partial.vaultPaths ? sanitizePaths(partial.vaultPaths) : d.vaultPaths,
    separateProjectsByPath:
      typeof partial.separateProjectsByPath === 'boolean'
        ? partial.separateProjectsByPath
        : d.separateProjectsByPath,
    gameLaunchParams: partial.gameLaunchParams
      ? sanitizePaths(partial.gameLaunchParams)
      : d.gameLaunchParams
  }
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

import { app, dialog, ipcMain } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Session } from '../auth/session'
import type { DownloadsManager } from '../downloads-manager'
import type { KvStore } from '../db/kv'
import type { SettingsStore } from '../settings'
import {
  fetchEngineInstallPlan,
  listOwnedEngines,
  type EngineInstallPlan,
  type EngineSku
} from './engine-catalog-client'
import { describeComponents, type ComponentDescriptor } from './install-tags'

/**
 * IPC surface for the engine-download feature. The renderer goes through
 * three steps:
 *
 * 1. `engine-downloads:list-owned` → which engine SKUs the user owns.
 * 2. `engine-downloads:fetch-install-plan` → for a chosen SKU, download
 *    + parse the manifest, return the per-tag histogram + version info
 *    so the components dialog can render. The parsed manifest itself
 *    stays in main (it's ~35 MB JSON for UE 5.8 — too heavy to ship over
 *    IPC) and is cached against `appName` for the next step.
 * 3. `engine-downloads:install` (task #15) → kick off the chunk runner
 *    against the cached plan + the user's tag selection + install dir.
 *
 * The cache is keyed by `appName` because that's the natural primary key
 * for the renderer (the dropdown is "UE_5.8" etc.). Plans expire when
 * the signed CDN URLs do (≈ 1 hour) — re-fetching is cheap.
 */

interface CachedPlan {
  plan: EngineInstallPlan
  /** Epoch ms the plan was fetched. Used so a stale plan (CDN URL signed
   *  for a now-expired window) can be evicted without surprises. */
  fetchedAt: number
}

const PLAN_TTL_MS = 45 * 60 * 1000 // 45 min — CDN tokens last ~60.
const planCache = new Map<string, CachedPlan>()

/**
 * Disk-persisted cache of the "owned engines" list. Same data Epic returns
 * from `listOwnedAssets` filtered down to UE namespaces; refreshed in the
 * background at startup and on explicit user Refresh from the picker. The
 * TTL is user-controlled via `settings.ownedEnginesCacheTtlDays` — 0 disables
 * the cache entirely (always hits the network).
 */
const OWNED_ENGINES_CACHE_KEY = 'owned_engines_cache_v1'
interface OwnedEnginesCachePayload {
  engines: EngineSku[]
  /** Epoch ms when the network fetch that populated this payload completed. */
  fetchedAt: number
}

export interface EngineDownloadsListOwnedResult {
  ok: boolean
  error?: string
  engines?: EngineSku[]
  /** True when the response was served from the disk cache rather than a fresh network fetch. */
  cached?: boolean
  /** Epoch ms of the underlying fetch — for "last refreshed N hours ago" UI. */
  fetchedAt?: number
  /** Set when we served stale cache because the live refresh wasn't possible (e.g. not authenticated). The renderer can surface a hint without treating it as an error. */
  staleReason?: string
}

/** Lightweight install-plan summary shipped over IPC. Excludes the parsed
 *  manifest (multi-MB) — the renderer never needs the full file list, only
 *  the per-tag breakdown. */
export interface EngineInstallPlanSummary {
  appName: string
  buildVersion: string
  manifestHash: string
  totalCompressedBytes: number
  totalDecompressedBytes: number
  components: ComponentDescriptor[]
  /** Echoed back so the renderer can show "Manifest fetched at HH:MM"
   *  if the plan stays open longer than the CDN window. */
  fetchedAt: number
}

export interface EngineDownloadsFetchPlanResult {
  ok: boolean
  error?: string
  summary?: EngineInstallPlanSummary
}

export interface EngineDownloadsInstallResult {
  ok: boolean
  error?: string
  /** ID of the queued `downloads` row, useful for the renderer to navigate
   *  the Downloads tab to the newly-created entry. */
  downloadId?: string
}

export interface EngineDownloadsPickDirResult {
  ok: boolean
  error?: string
  /** Absolute path the user picked. `null` when the dialog was cancelled. */
  path?: string | null
}

export interface EngineDownloadsSuggestDirResult {
  ok: boolean
  error?: string
  /** Absolute default install path for `appName`. */
  path?: string
}

export interface EngineDownloadsCheckDirResult {
  ok: boolean
  error?: string
  /** True when `installDir` falls under a Windows UAC-protected location
   *  (Program Files, Program Files (x86), Windows). Always `false` on
   *  Linux/macOS — those don't gate user writes to typical install paths. */
  requiresAdmin: boolean
  /** True when the running ReHoarder process is admin-elevated (per-user
   *  Windows installs default to non-elevated). On non-Windows always true. */
  isElevated: boolean
  /** Echoed back so the renderer can label the confirm modal. */
  installDir: string
}

export interface EngineDownloadsRelaunchResult {
  ok: boolean
  error?: string
}

export function registerEngineDownloadsIpc(
  session: Session,
  downloadsManager: DownloadsManager,
  settings: SettingsStore,
  kv: KvStore
): void {
  ipcMain.handle(
    'engine-downloads:list-owned',
    async (
      _event,
      opts: { forceRefresh?: boolean } = {}
    ): Promise<EngineDownloadsListOwnedResult> => {
      const force = opts.forceRefresh === true
      try {
        const result = await getOwnedEngines({
          token: session.getAccessToken(),
          forceRefresh: force,
          ttlMs: ttlMsFromSettings(settings),
          kv
        })
        return {
          ok: true,
          engines: result.engines,
          cached: result.cached,
          fetchedAt: result.fetchedAt,
          ...(result.staleReason ? { staleReason: result.staleReason } : {})
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'engine-downloads:fetch-install-plan',
    async (
      _event,
      sku: { namespace: string; catalogItemId: string; appName: string }
    ): Promise<EngineDownloadsFetchPlanResult> => {
      const token = session.getAccessToken()
      if (!token) {
        return { ok: false, error: 'Not authenticated — log in first.' }
      }
      try {
        const plan = await getOrFetchPlan(token, sku)
        return {
          ok: true,
          summary: {
            appName: plan.entry.plan.appName,
            buildVersion: plan.entry.plan.buildVersion,
            manifestHash: plan.entry.plan.manifestHash,
            totalCompressedBytes: plan.entry.plan.totalCompressedBytes,
            totalDecompressedBytes: plan.entry.plan.totalDecompressedBytes,
            components: describeComponents(plan.entry.plan.installTagsHistogram),
            fetchedAt: plan.entry.fetchedAt
          }
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'engine-downloads:check-install-dir',
    async (_event, installDir: string): Promise<EngineDownloadsCheckDirResult> => {
      const requiresAdmin = pathRequiresAdmin(installDir)
      const elevated = isElevatedNow()
      return {
        ok: true,
        requiresAdmin,
        isElevated: elevated,
        installDir
      }
    }
  )

  ipcMain.handle(
    'engine-downloads:relaunch-elevated',
    async (): Promise<EngineDownloadsRelaunchResult> => {
      try {
        relaunchElevatedWindows()
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'engine-downloads:suggest-install-dir',
    async (_event, appName: string): Promise<EngineDownloadsSuggestDirResult> => {
      try {
        return { ok: true, path: suggestInstallDir(settings, appName) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'engine-downloads:pick-install-dir',
    async (
      _event,
      defaultPath: string | null
    ): Promise<EngineDownloadsPickDirResult> => {
      try {
        const r = await dialog.showOpenDialog({
          title: 'Pick install location for the engine',
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: defaultPath ?? undefined
        })
        if (r.canceled || r.filePaths.length === 0) return { ok: true, path: null }
        return { ok: true, path: r.filePaths[0] }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'engine-downloads:install',
    async (
      _event,
      args: {
        sku: { namespace: string; catalogItemId: string; appName: string; shortVersion: string }
        selectedTags: string[]
        installDir: string
      }
    ): Promise<EngineDownloadsInstallResult> => {
      const token = session.getAccessToken()
      if (!token) {
        return { ok: false, error: 'Not authenticated — log in first.' }
      }
      const installDir = args.installDir.trim()
      if (installDir.length === 0) {
        return { ok: false, error: 'Install directory is required.' }
      }
      try {
        const fresh = await getOrFetchPlan(token, args.sku)
        const row = downloadsManager.enqueueEngine({
          appName: args.sku.appName,
          shortVersion: args.sku.shortVersion,
          buildVersion: fresh.entry.plan.buildVersion,
          installDir,
          plan: fresh.entry.plan,
          selectedTags: new Set(args.selectedTags)
        })
        return { ok: true, downloadId: row.id }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

/**
 * Returns `true` when the path is rooted in a Windows location that
 * requires UAC elevation for normal writes — Program Files, Program Files
 * (x86), or the Windows folder itself. We deliberately do NOT include
 * `C:\ProgramData\` (many apps write there as a regular user) or the bare
 * system drive root (`C:\`) since user-created top-level folders there
 * are usually writable.
 */
function pathRequiresAdmin(installDir: string): boolean {
  if (process.platform !== 'win32') return false
  const normalised = path.resolve(installDir).toLowerCase().replace(/\\+$/, '')
  // `path.win32` knows about the system drive. Cover both 32-bit and 64-bit
  // Program Files variants regardless of drive letter (rare but possible).
  const candidates = [
    process.env['ProgramFiles']?.toLowerCase(),
    process.env['ProgramFiles(x86)']?.toLowerCase(),
    process.env['ProgramW6432']?.toLowerCase(),
    process.env.SystemRoot?.toLowerCase(),
    process.env.windir?.toLowerCase()
  ].filter((s): s is string => !!s && s.length > 0)
  for (const c of candidates) {
    const root = c.replace(/\\+$/, '')
    if (normalised === root || normalised.startsWith(root + '\\')) return true
  }
  // Hard-coded English fallbacks in case env vars are missing (corporate
  // GPO setups occasionally strip them).
  const fallback = ['c:\\program files', 'c:\\program files (x86)', 'c:\\windows']
  for (const root of fallback) {
    if (normalised === root || normalised.startsWith(root + '\\')) return true
  }
  return false
}

/**
 * Detect whether the current process is running with admin privileges.
 * The canonical Windows trick is `net session`: it returns 0 when the
 * caller has admin (the command lists local SMB sessions, a privileged
 * operation) and non-zero with an "Access is denied" error otherwise. We
 * suppress stdio so the user never sees the side-channel output.
 *
 * On non-Windows platforms we report `true` — they don't enforce admin
 * on the typical install paths the engines feature uses.
 */
function isElevatedNow(): boolean {
  if (process.platform !== 'win32') return true
  try {
    const r = spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

/**
 * Re-spawn ReHoarder under a UAC elevation prompt and exit the current
 * process. Uses a temporary VBScript driven through `wscript.exe` that
 * calls `Shell.Application.ShellExecute("ReHoarder.exe", "", "", "runas", 1)` —
 * the canonical Windows pattern (used by sudo-prompt, Windows installers,
 * legacy Squirrel-style updaters) that:
 *   - is decoupled from PowerShell's variable startup cost and the cold-
 *     console quirks a hidden detached `powershell -WindowStyle Hidden` hits;
 *   - finishes within a few hundred milliseconds (wscript reads the script,
 *     fires ShellExecute, exits) so the UAC chain is well past the parent-
 *     process job-object teardown before we quit;
 *   - works identically on packaged Velopack installs and standalone exe
 *     layouts because `process.execPath` always points at the inner
 *     `current\ReHoarder.exe`, which is a valid `ShellExecute` target.
 *
 * The previous PowerShell approach worked unattended in tests but failed
 * silently in the wild on some Velopack-installed instances — the most
 * likely cause is the detached `powershell.exe` being torn down with the
 * parent before `Start-Process -Verb RunAs` had a chance to push the
 * elevation request to `consent.exe`.
 *
 * The relaunched copy inherits the same `userData` dir so settings + the
 * downloads queue persist; the in-memory engine plan does NOT persist, so
 * the user re-opens the dialog after restart.
 */
function relaunchElevatedWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('Elevation is only meaningful on Windows.')
  }
  if (!app.isPackaged) {
    // In dev, `process.execPath` points at `node_modules\electron\dist\electron.exe`,
    // not at a packaged ReHoarder.exe — UAC-launching that would re-spawn a
    // bare Electron without the dev server / preload bindings. Tell the user
    // to relaunch their dev terminal as admin instead.
    throw new Error(
      'Elevation relaunch is only available in packaged builds. ' +
        'In dev, close ReHoarder and run `npm run dev` from a terminal you started with "Run as administrator".'
    )
  }
  // VBS double-quote escape is `""` for a literal `"`. Real-world install
  // paths under %LocalAppData% never contain quotes; the replace is defensive.
  const exe = process.execPath.replace(/"/g, '""')
  const vbs =
    'Set objShell = CreateObject("Shell.Application")\r\n' +
    `objShell.ShellExecute "${exe}", "", "", "runas", 1\r\n`
  const vbsPath = path.join(os.tmpdir(), `rehoarder-elevate-${Date.now()}.vbs`)
  writeFileSync(vbsPath, vbs, 'utf-8')
  const child = spawn('wscript.exe', [vbsPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  // Give wscript time to load the script + fire ShellExecute before we quit.
  // After that, the elevated launch is owned by consent.exe + the new admin
  // session — fully independent of our process tree.
  setTimeout(() => app.quit(), 800)
}

/**
 * Pick a sensible writable default install location for the engine. Priority:
 *  1. First entry in `settings.enginePaths` — the user has already declared
 *     where engines should live; install next to the existing ones.
 *  2. `<userData>/EngineDownloads/<appName>` as a safe writable fallback —
 *     `os.homedir()/Epic Games` collides too easily with an existing Epic
 *     Games Launcher install (and on locked-down corporate setups that may
 *     also be restricted). The userData dir is always writable.
 *
 * Deliberately NOT `C:\Program Files\Epic Games` even though the official
 * launcher uses that — EGL runs elevated, ReHoarder doesn't, so writing
 * there hits EPERM mid-mkdir.
 */
function suggestInstallDir(settings: SettingsStore, appName: string): string {
  const cfg = settings.load()
  const trimmed = (cfg.enginePaths[0] ?? '').replace(/[\\/]+$/, '').trim()
  if (trimmed.length > 0) {
    return path.join(trimmed, appName)
  }
  return path.join(app.getPath('home'), 'Epic Games', appName)
}

/** Cache lookup with auto-refresh — used by both `fetch-install-plan` (UI)
 *  and `install` (queue). Returning the entry instead of just the plan lets
 *  callers reuse `fetchedAt` without re-reading the cache. */
async function getOrFetchPlan(
  token: string,
  sku: { namespace: string; catalogItemId: string; appName: string }
): Promise<{ entry: CachedPlan }> {
  const cached = planCache.get(sku.appName)
  const now = Date.now()
  if (cached && now - cached.fetchedAt < PLAN_TTL_MS) {
    return { entry: cached }
  }
  const plan = await fetchEngineInstallPlan(token, sku)
  const entry: CachedPlan = { plan, fetchedAt: now }
  planCache.set(sku.appName, entry)
  return { entry }
}

/**
 * Read/write helpers for the persisted owned-engines cache, plus the
 * cache-or-fetch coordinator used by both the IPC handler and the
 * startup background refresh.
 */
function readOwnedEnginesCache(kv: KvStore): OwnedEnginesCachePayload | null {
  const raw = kv.getJson<OwnedEnginesCachePayload>(OWNED_ENGINES_CACHE_KEY)
  if (!raw || !Array.isArray(raw.engines) || typeof raw.fetchedAt !== 'number') {
    return null
  }
  return raw
}

function writeOwnedEnginesCache(kv: KvStore, engines: EngineSku[]): OwnedEnginesCachePayload {
  const payload: OwnedEnginesCachePayload = { engines, fetchedAt: Date.now() }
  kv.setJson(OWNED_ENGINES_CACHE_KEY, payload)
  return payload
}

function ttlMsFromSettings(settings: SettingsStore): number {
  const days = settings.load().ownedEnginesCacheTtlDays
  // 0 means "always refresh"; mergeSettings already clamped the value.
  return days > 0 ? days * 24 * 60 * 60 * 1000 : 0
}

async function getOwnedEngines(opts: {
  token: string | null
  forceRefresh: boolean
  ttlMs: number
  kv: KvStore
}): Promise<{
  engines: EngineSku[]
  cached: boolean
  fetchedAt: number
  staleReason?: string
}> {
  const cache = readOwnedEnginesCache(opts.kv)
  const now = Date.now()
  const cacheFresh =
    cache !== null && opts.ttlMs > 0 && now - cache.fetchedAt < opts.ttlMs
  if (cache && cacheFresh && !opts.forceRefresh) {
    return { engines: cache.engines, cached: true, fetchedAt: cache.fetchedAt }
  }
  if (!opts.token) {
    if (cache) {
      // Best-effort: serve stale rather than failing. The renderer can show a
      // "log in to refresh" hint via `staleReason`.
      return {
        engines: cache.engines,
        cached: true,
        fetchedAt: cache.fetchedAt,
        staleReason: 'Not authenticated — showing the last cached list. Log in to refresh.'
      }
    }
    throw new Error('Not authenticated — log in first.')
  }
  const engines = await listOwnedEngines(opts.token)
  const payload = writeOwnedEnginesCache(opts.kv, engines)
  return { engines, cached: false, fetchedAt: payload.fetchedAt }
}

/**
 * Fire-and-forget background refresh of the owned-engines cache. Wired
 * from `main/index.ts` after `whenReady` + `session.init` so the picker
 * stays fresh without ever blocking the user. Skips the network call when
 * the cache is already within the configured TTL.
 */
export async function runStartupOwnedEnginesRefresh(
  session: Session,
  settings: SettingsStore,
  kv: KvStore
): Promise<void> {
  try {
    const ttlMs = ttlMsFromSettings(settings)
    const cache = readOwnedEnginesCache(kv)
    const now = Date.now()
    const cacheFresh =
      cache !== null && ttlMs > 0 && now - cache.fetchedAt < ttlMs
    if (cacheFresh) return
    const token = session.getAccessToken()
    if (!token) return // user not signed in yet — refresh will happen on next user-triggered action
    await getOwnedEngines({ token, forceRefresh: true, ttlMs, kv })
  } catch (err) {
    console.warn('[engine-downloads] startup cache refresh failed:', err)
  }
}

/**
 * Retrieve a cached install plan for the actual chunk-download runner
 * (task #15). Stays inside the main process — the renderer never sees the
 * raw Manifest object.
 */
export function takeCachedPlan(appName: string): EngineInstallPlan | null {
  const cached = planCache.get(appName)
  if (!cached) return null
  if (Date.now() - cached.fetchedAt >= PLAN_TTL_MS) {
    planCache.delete(appName)
    return null
  }
  return cached.plan
}

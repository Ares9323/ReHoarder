import { app, dialog, ipcMain } from 'electron'
import * as path from 'node:path'
import type { Session } from '../auth/session'
import type { DownloadsManager } from '../downloads-manager'
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

export interface EngineDownloadsListOwnedResult {
  ok: boolean
  error?: string
  engines?: EngineSku[]
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

export function registerEngineDownloadsIpc(
  session: Session,
  downloadsManager: DownloadsManager,
  settings: SettingsStore
): void {
  ipcMain.handle(
    'engine-downloads:list-owned',
    async (): Promise<EngineDownloadsListOwnedResult> => {
      const token = session.getAccessToken()
      if (!token) {
        return { ok: false, error: 'Not authenticated — log in first.' }
      }
      try {
        const engines = await listOwnedEngines(token)
        return { ok: true, engines }
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

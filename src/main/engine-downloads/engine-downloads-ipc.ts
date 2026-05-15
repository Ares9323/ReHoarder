import { ipcMain } from 'electron'
import type { Session } from '../auth/session'
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

export function registerEngineDownloadsIpc(session: Session): void {
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
        // Cache hit short-circuit so re-opening the dialog with the same
        // engine doesn't re-download the 35 MB manifest.
        const cached = planCache.get(sku.appName)
        const now = Date.now()
        let plan: EngineInstallPlan
        let fetchedAt: number
        if (cached && now - cached.fetchedAt < PLAN_TTL_MS) {
          plan = cached.plan
          fetchedAt = cached.fetchedAt
        } else {
          plan = await fetchEngineInstallPlan(token, sku)
          fetchedAt = now
          planCache.set(sku.appName, { plan, fetchedAt })
        }
        return {
          ok: true,
          summary: {
            appName: plan.appName,
            buildVersion: plan.buildVersion,
            manifestHash: plan.manifestHash,
            totalCompressedBytes: plan.totalCompressedBytes,
            totalDecompressedBytes: plan.totalDecompressedBytes,
            components: describeComponents(plan.installTagsHistogram),
            fetchedAt
          }
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
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

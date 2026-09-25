import type { AssetRow, AssetsRepo, FabEntitlementInfo } from '../db/assets-repo'
import type { VaultClient } from '../vault/vault-client'
import type { EpicWebSessionFactory } from '../auth/epic-web-session'
import type { FabSessionClient } from '../fab/fab-session'
import { FabClient, type FabEntitlementPage } from '../fab/fab-client'
import { fabNextToPath, statusFromHttp, type FabWebSession } from '../fab/fab-web-session'

/** Acquired UE entitlements, newest first. Page size is fixed at 24 by Fab. */
const FAB_ENTITLEMENTS_PATH =
  '/i/library/search?source=acquired&asset_formats=unreal-engine&sort_by=-createdAt'

import {
  normalizeVaultAsset,
  normalizeFabAsset,
  extractFabUeCategories,
  normalizeFabEntitlement
} from './normalize'

export interface SyncSourceResult {
  fetched: number
  persisted: number
  error: string | null
}

export interface SyncResult {
  vault: SyncSourceResult
  fab: SyncSourceResult
}

export type SyncPhase = 'starting' | 'vault' | 'fab' | 'done' | 'error'

export interface SyncProgress {
  phase: SyncPhase
  vaultCount: number
  fabCount: number
  total: number
  error?: string
}

export type ProgressCallback = (progress: SyncProgress) => void
export type LogCallback = (line: string) => void

export class Sync {
  constructor(
    private readonly repo: AssetsRepo,
    private readonly vaultClient: VaultClient,
    private readonly epicWebSessionFactory: EpicWebSessionFactory,
    private readonly fabSessionClient: FabSessionClient,
    private readonly fabClient: FabClient,
    private readonly fabWebSession: Pick<FabWebSession, 'getJson'>
  ) {}

  async syncAll(
    accessToken: string,
    accountId: string,
    onProgress: ProgressCallback,
    onLog: LogCallback = () => {}
  ): Promise<SyncResult> {
    const now = Date.now()
    const result: SyncResult = {
      vault: { fetched: 0, persisted: 0, error: null },
      fab: { fetched: 0, persisted: 0, error: null }
    }

    onProgress({ phase: 'starting', vaultCount: 0, fabCount: 0, total: 0 })
    onLog('Sync started')

    const vaultPromise = this.syncVault(accessToken, now, result, onProgress, onLog)
    const fabPromise = this.syncFab(accessToken, accountId, now, result, onProgress, onLog)
    await Promise.allSettled([vaultPromise, fabPromise])

    this.writeSyncState(accountId, 'vault', now, result.vault.error)
    this.writeSyncState(accountId, 'fab', now, result.fab.error)

    onLog(
      `Sync complete. Vault: ${result.vault.persisted} persisted` +
        (result.vault.error ? ` (error: ${result.vault.error})` : '') +
        `. Fab: ${result.fab.persisted} persisted` +
        (result.fab.error ? ` (error: ${result.fab.error})` : '')
    )
    onProgress({
      phase: 'done',
      vaultCount: result.vault.persisted,
      fabCount: result.fab.persisted,
      total: result.vault.persisted + result.fab.persisted
    })

    return result
  }

  private async syncVault(
    accessToken: string,
    now: number,
    result: SyncResult,
    onProgress: ProgressCallback,
    onLog: LogCallback
  ): Promise<void> {
    try {
      onLog('Vault: fetching owned asset list…')
      const summaries = await this.vaultClient.listOwnedAssets(accessToken)
      result.vault.fetched = summaries.length
      onLog(`Vault: ${summaries.length} asset IDs received. Fetching catalog metadata…`)
      this.emitProgress(onProgress, 'vault', result)

      const catalogIds = summaries.map((s) => s.catalogItemId)
      const BATCH = 50
      const CONCURRENCY = 6
      const allCatalog: Record<string, NonNullable<ReturnType<typeof Object.values>[number]>> = {}
      const totalBatches = Math.ceil(catalogIds.length / BATCH)
      // Worker pool: each worker pulls the next batch index off a shared
      // counter until none remain. Node is single-threaded so the counter
      // and the result-merge are race-free even though the awaits interleave.
      let nextBatch = 0
      let completed = 0
      const runWorker = async (): Promise<void> => {
        while (true) {
          const batchIndex = nextBatch++
          if (batchIndex >= totalBatches) return
          const start = batchIndex * BATCH
          const batch = catalogIds.slice(start, start + BATCH)
          const partial = await this.vaultClient.fetchCatalogMetadata(accessToken, batch)
          Object.assign(allCatalog, partial)
          completed += 1
          onLog(`Vault: catalog batch ${completed}/${totalBatches} received`)
          this.emitProgress(onProgress, 'vault', result)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, totalBatches) }, () => runWorker())
      )

      onLog(`Vault: persisting ${summaries.length} rows…`)
      for (const summary of summaries) {
        const item = allCatalog[summary.catalogItemId]
        if (!item) continue
        this.repo.upsert(normalizeVaultAsset(summary, item, now))
        result.vault.persisted += 1
        if (result.vault.persisted % 100 === 0 || result.vault.persisted === summaries.length) {
          this.emitProgress(onProgress, 'vault', result)
        }
      }
      onLog(`Vault: done. ${result.vault.persisted} assets persisted.`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.vault.error = msg
      onLog(`Vault: ERROR — ${msg}`)
    }
  }

  /**
   * Walk the UE entitlements on `/i/library/search` and collect acquisition
   * date, last-updated date and licenses per Fab listing uid. The calls run
   * inside the fab.com web session (a signed-in browser page). Never throws:
   * a failure is logged as a warning and resolves to null, so the UE library
   * result and `result.fab.error` are unaffected.
   */
  private async collectFabEntitlements(
    onLog: LogCallback
  ): Promise<Map<string, FabEntitlementInfo> | null> {
    const map = new Map<string, FabEntitlementInfo>()
    const unavailable = (why: string): null => {
      onLog(`Fab: WARNING entitlements unavailable (${why}). Dates and licenses not refreshed.`)
      return null
    }
    try {
      const seen = new Set<string>()
      let path: string | null = FAB_ENTITLEMENTS_PATH
      let pageNum = 0
      while (path !== null && !seen.has(path)) {
        seen.add(path)
        const { status, body } = await this.fabWebSession.getJson<FabEntitlementPage>(path)
        if (statusFromHttp(status) === 'logged-out') {
          if (pageNum === 0) {
            onLog(
              'Fab: not signed in to fab.com, dates and licenses skipped. ' +
                'Use "Sign in to Fab" to enable them.'
            )
            return null
          }
          return unavailable(`HTTP ${status} on page ${pageNum + 1}`)
        }
        if (status < 200 || status >= 300 || body === null) {
          return unavailable(`HTTP ${status}`)
        }
        pageNum += 1
        const results = body.results ?? []
        for (const r of results) {
          const n = normalizeFabEntitlement(r)
          if (n) map.set(n.listingUid, n.info)
        }
        onLog(`Fab: entitlements page ${pageNum} received (+${results.length})`)
        path = fabNextToPath(body.next)
      }
      onLog(`Fab: entitlements collected for ${map.size} listings`)
      return map
    } catch (err) {
      return unavailable(err instanceof Error ? err.message : String(err))
    }
  }

  private async syncFab(
    accessToken: string,
    accountId: string,
    now: number,
    result: SyncResult,
    onProgress: ProgressCallback,
    onLog: LogCallback
  ): Promise<void> {
    try {
      onLog('Epic: bootstrapping web session…')
      const epicSession = await this.epicWebSessionFactory.create(accessToken, onLog)
      if (!epicSession.ue4SessionReady) {
        onLog('Epic: UE.com session bootstrap failed (non-fatal — Fab can proceed)')
      }
      onLog('Fab: establishing session…')
      const session = await this.fabSessionClient.establishSession(accessToken, epicSession, onLog)

      // Runs concurrently with the UE library walk. Never rejects: failures
      // are logged and resolve to null.
      const entitlementsPromise = this.collectFabEntitlements(onLog)

      // Track which IDs were already in DB just for the `pageNew` diagnostic
      // counter — it informs the user how much of each page they were missing.
      // (We used to early-stop when `pageNew === 0`, but the Fab UE library is
      // sorted by listing `createdAt`, NOT by acquisition time. Freebies of
      // the month are routinely listings created years ago, so an item the
      // user claimed yesterday appears DEEP in the paginated cursor — and the
      // early-stop guarantees we miss it on page 1. Asset Manager Studio's
      // approach is a full UE library sync every time; we follow suit for
      // correctness. The cost is ~20-30 s on a 2k+ library, which is the
      // price of a trustworthy "you already own this" indicator.)
      const knownFabIds = this.repo.knownSourceIds('fab')
      onLog(
        knownFabIds.size > 0
          ? `Fab: full UE sync (${knownFabIds.size} fab assets already in DB)`
          : 'Fab: full UE sync (DB empty for fab source)'
      )
      onLog('Fab: session established. Fetching library…')

      let pageNum = 0
      let skipped = 0
      for await (const page of this.fabClient.listLibrary(
        accessToken,
        session.cookieHeader,
        accountId
      )) {
        pageNum += 1
        result.fab.fetched += page.results.length
        let pageNew = 0
        for (const item of page.results) {
          if (!item.assetId) {
            skipped += 1
            continue
          }
          if (!knownFabIds.has(item.assetId)) pageNew += 1
          this.repo.upsert(normalizeFabAsset(item, now))
          this.repo.replaceTags('fab', item.assetId, extractFabUeCategories(item))
          result.fab.persisted += 1
        }
        onLog(
          `Fab: UE page ${pageNum} received (+${page.results.length} items, ${pageNew} new)`
        )
        this.emitProgress(onProgress, 'fab', result)
      }
      if (skipped > 0) {
        onLog(`Fab: skipped ${skipped} UE items with missing assetId`)
      }

      const entitlements = await entitlementsPromise
      if (entitlements) {
        const { matched, unmatched } = this.repo.applyFabEntitlements(entitlements)
        onLog(`Fab: entitlements applied to ${matched} assets, ${unmatched} unmatched`)
      }

      onLog(`Fab: done. ${result.fab.persisted} assets persisted.`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.fab.error = msg
      onLog(`Fab: ERROR — ${msg}`)
    }
  }

  /**
   * Refresh a single Fab asset's image_url (and only image_url for now —
   * the listing-detail endpoint returns lots more we could splatter in
   * later) by calling `https://www.fab.com/i/listings/<uid>`. This is the
   * authoritative source for the current asset preview, unlike the
   * library endpoint which can serve cached snapshots with stale image
   * URLs for hours after a listing edit.
   *
   * Returns `imageUrl` on success — `null` if Fab has no image for the
   * listing (rare). Returns `ok: false` on lookup failures, missing
   * listing UID, or Fab errors / non-listing payloads (e.g. mature
   * content gating). Caller is responsible for surfacing the error or
   * triggering a UI refresh — this method does NOT emit events.
   */
  async refreshAssetFromFab(
    source: 'vault' | 'fab' | 'legacy',
    sourceId: string
  ): Promise<{ ok: boolean; imageUrl?: string | null; error?: string }> {
    if (source !== 'fab') {
      return { ok: false, error: 'Refresh is only available for Fab assets' }
    }
    const asset = this.repo.findById(source, sourceId)
    if (!asset) return { ok: false, error: 'Asset not found in local catalog' }
    const listingUid = extractFabListingUid(asset)
    if (!listingUid) {
      return { ok: false, error: 'Cannot derive Fab listing UID for this asset' }
    }
    try {
      const detail = await this.fabClient.fetchListingDetail(listingUid)
      if (detail.detail) {
        return { ok: false, error: `Fab listing skipped: ${detail.detail}` }
      }
      const imageUrl = FabClient.pickListingImageUrl(detail)
      this.repo.updateImageUrlAndPreciseAt(source, sourceId, imageUrl, Date.now())
      return { ok: true, imageUrl }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private emitProgress(
    onProgress: ProgressCallback,
    phase: 'vault' | 'fab',
    result: SyncResult
  ): void {
    onProgress({
      phase,
      vaultCount: result.vault.persisted,
      fabCount: result.fab.persisted,
      total: result.vault.persisted + result.fab.persisted
    })
  }

  private writeSyncState(
    accountId: string,
    source: string,
    at: number,
    error: string | null
  ): void {
    const status = error === null ? 'ok' : 'error'
    this.repo.db
      .prepare(
        `INSERT INTO sync_state (account_id, source, last_sync_at, last_sync_status, last_sync_error)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, source) DO UPDATE SET
         last_sync_at = excluded.last_sync_at,
         last_sync_status = excluded.last_sync_status,
         last_sync_error = excluded.last_sync_error`
      )
      .run(accountId, source, at, status, error)
  }

  /**
   * Read sync state for the given account. When `accountId` is null (no
   * active account), returns an empty record so callers can render their
   * "never synced" empty state without special-casing the auth gate.
   */
  getLastSyncState(
    accountId: string | null
  ): Record<string, { at: number; status: string; error: string | null }> {
    if (accountId === null) return {}
    const rows = this.repo.db
      .prepare(
        `SELECT source, last_sync_at, last_sync_status, last_sync_error
           FROM sync_state
          WHERE account_id = ?`
      )
      .all(accountId) as Array<{
      source: string
      last_sync_at: number
      last_sync_status: string
      last_sync_error: string | null
    }>
    return Object.fromEntries(
      rows.map((r) => [
        r.source,
        { at: r.last_sync_at, status: r.last_sync_status, error: r.last_sync_error }
      ])
    )
  }
}

/**
 * Derive the Fab listing UID (the canonical id used by `/i/listings/<uid>`)
 * from a Fab UE asset row: taken from `productUrl`
 * (`https://www.fab.com/listings/<uid>[/<slug>]`), else from the raw
 * payload's `customAttributes.ListingIdentifier` when the URL is malformed.
 *
 * Returns `null` when nothing usable is recoverable; the caller should treat
 * it as "refresh unavailable for this asset" rather than retry.
 */
function extractFabListingUid(asset: AssetRow): string | null {
  if (asset.productUrl) {
    const m = asset.productUrl.match(/\/listings\/([^/?#]+)/)
    if (m && m[1].length > 0) return m[1]
  }
  if (asset.raw) {
    try {
      const parsed = JSON.parse(asset.raw) as {
        customAttributes?: Array<{ ListingIdentifier?: unknown }>
      }
      if (Array.isArray(parsed.customAttributes)) {
        for (const attr of parsed.customAttributes) {
          if (typeof attr?.ListingIdentifier === 'string' && attr.ListingIdentifier.length > 0) {
            return attr.ListingIdentifier
          }
        }
      }
    } catch {
      /* malformed JSON — fall through to null */
    }
  }
  return null
}

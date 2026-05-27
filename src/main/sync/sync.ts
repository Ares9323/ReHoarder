import type { AssetRow, AssetsRepo } from '../db/assets-repo'
import type { VaultClient } from '../vault/vault-client'
import type { EpicWebSessionFactory } from '../auth/epic-web-session'
import type { FabSessionClient } from '../fab/fab-session'
import { FabClient } from '../fab/fab-client'

/**
 * TEMPORARY (0.2.0): `fab.com/i/library/search` (the Fab "Other library" — non-UE
 * assets) is returning 401 on every authenticated request we make to it, even
 * though the same session.cookieHeader works fine for `/e/accounts/.../ue/library`.
 * Suspected root cause is a missing CSRF header or a Fab API change; until we
 * confirm the fix, skip the entire Other-library sync pass so we don't waste a
 * round-trip and pollute the log with the error. The UE library is the only
 * source for ReHoarder's primary use case anyway — non-UE assets will simply
 * stop being mirrored locally until this is re-enabled.
 *
 * Flip back to `false` once the 401 is fixed (see `fab-client.ts:listOtherLibrary`).
 */
const SKIP_FAB_OTHER_LIBRARY = true

import {
  normalizeVaultAsset,
  normalizeFabAsset,
  normalizeFabOtherAsset,
  isUnrealEngineListing,
  extractFabUeCategories,
  extractFabOtherCategories
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
    private readonly fabClient: FabClient
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

      if (SKIP_FAB_OTHER_LIBRARY) {
        onLog('Fab: Other library sync skipped (temporarily disabled — endpoint returns 401)')
      } else {
      onLog('Fab: fetching Other library (non-UE assets)…')
      let otherPageNum = 0
      let otherSkipped = 0
      let otherDup = 0
      // Same reasoning as the UE library: the Other library is sorted by
      // listing creation date, not acquisition date, so an asset claimed
      // today might show up only on page 12 of an old freebie listing.
      // Paginate the full thing so the local cross-reference catches it.
      for await (const page of this.fabClient.listOtherLibrary(session.cookieHeader)) {
        otherPageNum += 1
        result.fab.fetched += page.results.length
        let pageNew = 0
        for (const { listing } of page.results) {
          if (!listing || !listing.uid) {
            otherSkipped += 1
            continue
          }
          if (isUnrealEngineListing(listing)) {
            otherDup += 1
            continue
          }
          if (!knownFabIds.has(listing.uid)) pageNew += 1
          this.repo.upsert(normalizeFabOtherAsset(listing, now))
          this.repo.replaceTags('fab', listing.uid, extractFabOtherCategories(listing))
          result.fab.persisted += 1
        }
        onLog(
          `Fab: Other page ${otherPageNum} received (+${page.results.length} listings, ${pageNew} new)`
        )
        this.emitProgress(onProgress, 'fab', result)
      }
      if (otherSkipped > 0) {
        onLog(`Fab: skipped ${otherSkipped} Other listings with missing uid`)
      }
      if (otherDup > 0) {
        onLog(`Fab: skipped ${otherDup} Other listings already covered by UE library`)
      }
      onLog(`Fab: done. ${result.fab.persisted} assets persisted.`)
      } // close `else` branch of SKIP_FAB_OTHER_LIBRARY
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
 * from a Fab asset row. The library endpoint splits its rows across two
 * shapes that store the uid in different places:
 *   - `sub_source = 'fab-other'`: the listing uid IS the `sourceId` field.
 *   - `sub_source = 'fab-ue'`:    the listing uid lives in `productUrl`
 *                                  (`https://www.fab.com/listings/<uid>[/<slug>]`)
 *                                  or, when the URL is malformed, in the raw
 *                                  payload's `customAttributes.ListingIdentifier`.
 *
 * Returns `null` when nothing usable is recoverable — caller should treat
 * as "refresh unavailable for this asset" rather than retry.
 */
function extractFabListingUid(asset: AssetRow): string | null {
  if (asset.subSource === 'fab-other') return asset.sourceId
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

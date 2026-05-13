import type { AssetsRepo } from '../db/assets-repo'
import type { VaultClient } from '../vault/vault-client'
import type { EpicWebSessionFactory } from '../auth/epic-web-session'
import type { FabSessionClient } from '../fab/fab-session'
import type { FabClient } from '../fab/fab-client'
import {
  normalizeVaultAsset,
  normalizeFabAsset,
  normalizeFabOtherAsset,
  isUnrealEngineListing
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

    this.writeSyncState('vault', now, result.vault.error)
    this.writeSyncState('fab', now, result.fab.error)

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

      // Incremental pagination: snapshot every Fab source_id currently in DB.
      // Both the UE library and the Other library are ordered by -createdAt,
      // so the moment we hit a page where every item is already known, the
      // rest of the cursor is guaranteed to be older still-known territory
      // and we stop fetching.
      const knownFabIds = this.repo.knownSourceIds('fab')
      const incremental = knownFabIds.size > 0
      onLog(
        incremental
          ? `Fab: incremental sync (${knownFabIds.size} assets already in DB)`
          : 'Fab: full sync (DB empty for fab source)'
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
          result.fab.persisted += 1
        }
        onLog(
          `Fab: UE page ${pageNum} received (+${page.results.length} items, ${pageNew} new)`
        )
        this.emitProgress(onProgress, 'fab', result)
        if (incremental && page.results.length > 0 && pageNew === 0) {
          onLog(`Fab: UE early-stop at page ${pageNum} (no new items on page)`)
          break
        }
      }
      if (skipped > 0) {
        onLog(`Fab: skipped ${skipped} UE items with missing assetId`)
      }

      onLog('Fab: fetching Other library (non-UE assets)…')
      let otherPageNum = 0
      let otherSkipped = 0
      let otherDup = 0
      for await (const page of this.fabClient.listOtherLibrary(session.cookieHeader)) {
        otherPageNum += 1
        result.fab.fetched += page.results.length
        let pageNew = 0
        let pageProcessable = 0
        for (const { listing } of page.results) {
          if (!listing || !listing.uid) {
            otherSkipped += 1
            continue
          }
          if (isUnrealEngineListing(listing)) {
            otherDup += 1
            continue
          }
          pageProcessable += 1
          if (!knownFabIds.has(listing.uid)) pageNew += 1
          this.repo.upsert(normalizeFabOtherAsset(listing, now))
          result.fab.persisted += 1
        }
        onLog(
          `Fab: Other page ${otherPageNum} received (+${page.results.length} listings, ${pageNew} new)`
        )
        this.emitProgress(onProgress, 'fab', result)
        if (incremental && pageProcessable > 0 && pageNew === 0) {
          onLog(`Fab: Other early-stop at page ${otherPageNum} (no new listings on page)`)
          break
        }
      }
      if (otherSkipped > 0) {
        onLog(`Fab: skipped ${otherSkipped} Other listings with missing uid`)
      }
      if (otherDup > 0) {
        onLog(`Fab: skipped ${otherDup} Other listings already covered by UE library`)
      }
      onLog(`Fab: done. ${result.fab.persisted} assets persisted.`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.fab.error = msg
      onLog(`Fab: ERROR — ${msg}`)
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

  private writeSyncState(source: string, at: number, error: string | null): void {
    const status = error === null ? 'ok' : 'error'
    this.repo.db
      .prepare(
        `INSERT INTO sync_state (source, last_sync_at, last_sync_status, last_sync_error)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         last_sync_at = excluded.last_sync_at,
         last_sync_status = excluded.last_sync_status,
         last_sync_error = excluded.last_sync_error`
      )
      .run(source, at, status, error)
  }

  getLastSyncState(): Record<string, { at: number; status: string; error: string | null }> {
    const rows = this.repo.db
      .prepare('SELECT source, last_sync_at, last_sync_status, last_sync_error FROM sync_state')
      .all() as Array<{
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

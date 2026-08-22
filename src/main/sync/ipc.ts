import { ipcMain, session as electronSession, type BrowserWindow } from 'electron'
import type { AssetsRepo, AssetSource } from '../db/assets-repo'
import type { Sync, SyncProgress } from './sync'
import type { Session } from '../auth/session'
import type { EpicWebSessionFactory } from '../auth/epic-web-session'
import type { FabSessionClient } from '../fab/fab-session'
import { FabFreebiesClient, type FabFreebie } from '../fab/fab-freebies'
import type { KvStore } from '../db/kv'
import {
  claimedUidsKey,
  lastSeenUidsKey,
  lastAutoSyncAtKey,
  readUidSet,
  writeUidSet,
  readTimestamp,
  writeTimestamp
} from './freebies-kv'
import { applyClaimedFlags } from './freebies-claimed'
import { setClaimedInKv } from './set-freebies-claimed'
import { decideAutoCheck, diffNewUids } from './auto-check'

export interface LibraryQuery {
  source?: AssetSource
  subSource?: 'fab-ue' | 'fab-other'
  listingType?: string
  category?: string
  search?: string
  includeHidden?: boolean
  onlyHidden?: boolean
  onlyBookmarked?: boolean
}

export interface LibraryListResult {
  assets: ReturnType<AssetsRepo['list']>
  countsBySource: Record<string, number>
  /** Distinct listing-type slugs available in the DB right now, for populating the UI dropdown. */
  availableListingTypes: string[]
  /** Distinct category tags (Fab Categories), excluding listing-type slugs. */
  availableCategories: string[]
  lastSync: Record<string, { at: number; status: string; error: string | null }>
}

export interface FreebiesResult {
  ok: boolean
  error?: string
  freebies?: FabFreebie[]
  /** Wall-clock ms the result was fetched at — the caller can use it to
   *  decide whether to re-fetch. */
  fetchedAt?: number
}

export interface FreebiesDeps {
  epicWebSessionFactory: EpicWebSessionFactory
  fabSessionClient: FabSessionClient
  fabFetch: typeof fetch
  /** Used to persist per-account freebies state (`freebies.lastAutoSyncAt.<accountId>`,
   *  `freebies.lastSeenUids.<accountId>`, `freebies.claimedUids.<accountId>`) and to
   *  read settings inside IPC handlers. */
  kv: KvStore
}

/**
 * Partition name used by both Fab and UE Vault `electron.net.fetch` adapters
 * (see `CF_PARTITION` in `main/index.ts`). The Chromium HTTP cache on this
 * partition is what `library:sync` flushes before each manual sync, so
 * library-API responses are re-fetched from origin instead of served stale
 * from cache — keep this string in sync if `CF_PARTITION` ever changes.
 */
const FAB_SYNC_PARTITION = 'persist:cf-warmup'

export function registerLibraryIpc(
  repo: AssetsRepo,
  sync: Sync,
  session: Session,
  getMainWindow: () => BrowserWindow | null,
  freebiesDeps: FreebiesDeps
): void {
  // Process-lifetime cache: the Fab blade endpoint changes monthly, so caching
  // for a few minutes is plenty. The renderer can pass `force: true` to bust
  // the cache on demand (e.g. the user hit the refresh button).
  const FREEBIES_TTL_MS = 5 * 60_000
  let freebiesCache: { freebies: FabFreebie[]; fetchedAt: number } | null = null
  const freebiesClient = new FabFreebiesClient(freebiesDeps.fabFetch)

  /**
   * Shared freebies fetch path used by both `library:list-freebies` (renderer
   * "give me the current list") and `library:freebies-auto-check` (startup
   * throttled refresh probe). Hits the in-process cache first, falls through
   * to the network if missing/forced, and stamps each item's `claimed` flag
   * from the active account's manual KV set.
   */
  async function fetchFreebies(opts: { force: boolean }): Promise<FreebiesResult> {
    if (!opts.force && freebiesCache && Date.now() - freebiesCache.fetchedAt < FREEBIES_TTL_MS) {
      return {
        ok: true,
        freebies: freebiesCache.freebies,
        fetchedAt: freebiesCache.fetchedAt
      }
    }
    const token = session.getAccessToken()
    const state = session.getState()
    if (token === null || state.status !== 'authenticated') {
      return { ok: false, error: 'Not authenticated.' }
    }
    try {
      const onLog = (msg: string): void => console.warn(`[freebies/auth] ${msg}`)
      const epicSession = await freebiesDeps.epicWebSessionFactory.create(token, onLog)
      const { cookieHeader } = await freebiesDeps.fabSessionClient.establishSession(
        token,
        epicSession,
        onLog
      )
      const freebies = await freebiesClient.listFreebies(cookieHeader)
      // Claimed is manual-only: read the active account's dismissed set and
      // stamp each freebie. No network ownership check, no local cross-ref.
      const claimed = readUidSet(freebiesDeps.kv, claimedUidsKey(state.accountId))
      applyClaimedFlags(freebies, claimed)
      const fetchedAt = Date.now()
      freebiesCache = { freebies, fetchedAt }
      return { ok: true, freebies, fetchedAt }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // The cache holds freebies with `claimed` flags resolved from the previous
  // account's KV set. Wipe it whenever the active account changes so the next
  // list re-resolves against the new account's claimed set.
  session.on('state-changed', () => {
    freebiesCache = null
  })
  ipcMain.handle('library:list', (_e, query: LibraryQuery): LibraryListResult => {
    const state = session.getState()
    const activeId = state.status === 'authenticated' ? state.accountId : null
    return {
      assets: repo.list(query),
      countsBySource: repo.countBySource(),
      availableListingTypes: repo.availableListingTypes(),
      availableCategories: repo.availableCategories(),
      lastSync: sync.getLastSyncState(activeId)
    }
  })

  ipcMain.handle(
    'library:set-hidden',
    (_e, source: AssetSource, sourceId: string, hidden: boolean): void => {
      repo.setHidden(source, sourceId, hidden)
    }
  )

  ipcMain.handle(
    'library:set-bookmarked',
    (_e, source: AssetSource, sourceId: string, bookmarked: boolean): void => {
      repo.setBookmarked(source, sourceId, bookmarked)
    }
  )

  ipcMain.handle(
    'library:list-freebies',
    async (_e, opts: { force?: boolean } = {}): Promise<FreebiesResult> => {
      return fetchFreebies({ force: opts.force === true })
    }
  )

  ipcMain.handle(
    'library:set-freebies-claimed',
    (
      _e,
      uids: string[],
      claimed: boolean
    ): { ok: boolean; error?: string; claimedUids?: string[] } => {
      const state = session.getState()
      if (state.status !== 'authenticated') {
        return { ok: false, error: 'Not authenticated.' }
      }
      try {
        const updated = setClaimedInKv(freebiesDeps.kv, state.accountId, uids, claimed)
        // Invalidate the in-process cache so a subsequent list re-resolves the
        // claimed flags from the freshly-written KV set.
        freebiesCache = null
        return { ok: true, claimedUids: updated }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /**
   * Startup-only "are there new/unclaimed freebies?" probe. The renderer
   * calls this once on every app launch (and after account switches) and
   * uses the returned reason purely for logging/UX bookkeeping; the toast
   * decision itself is driven by `unclaimedCount`:
   *
   *   - `not-authenticated` → no active account; nothing to do.
   *   - `within-cap`    → less than 7 days since the last check for this
   *                       account; skip the network, report the count off
   *                       the last-seen set.
   *   - `changed`       → fetched fresh and found at least one uid not seen
   *                       before (a new batch dropped).
   *   - `unchanged`     → fetched fresh, no new uids (or the fetch failed).
   *
   * No library sync is kicked here — this is a read-only probe scoped to
   * the freebies blade. Manual syncs (Assets tab "Sync now") are unrelated.
   */
  ipcMain.handle(
    'library:freebies-auto-check',
    async (): Promise<{
      reason: 'changed' | 'unchanged' | 'within-cap' | 'not-authenticated'
      unclaimedCount: number
    }> => {
      const state = session.getState()
      if (state.status !== 'authenticated') {
        return { reason: 'not-authenticated', unclaimedCount: 0 }
      }
      const accountId = state.accountId
      const now = Date.now()
      const lastAutoSyncAt = readTimestamp(freebiesDeps.kv, lastAutoSyncAtKey(accountId))
      const claimed = readUidSet(freebiesDeps.kv, claimedUidsKey(accountId))

      if (decideAutoCheck({ lastAutoSyncAt, now }).withinCap) {
        // Too soon since the last check: report the count off the last-seen
        // set without hitting the network.
        const lastSeen = readUidSet(freebiesDeps.kv, lastSeenUidsKey(accountId))
        const unclaimedCount = [...lastSeen].filter((u) => !claimed.has(u)).length
        return { reason: 'within-cap', unclaimedCount }
      }

      const r = await fetchFreebies({ force: false })
      if (!r.ok || !r.freebies) {
        // Fetch failed: do NOT advance lastAutoSyncAt, so the next launch
        // retries. Report a zero count; never blocks the UI.
        return { reason: 'unchanged', unclaimedCount: 0 }
      }
      const currentUids = r.freebies.map((f) => f.uid).filter((u) => u.length > 0)
      const lastSeen = readUidSet(freebiesDeps.kv, lastSeenUidsKey(accountId))
      const newUids = diffNewUids(currentUids, lastSeen)
      writeUidSet(freebiesDeps.kv, lastSeenUidsKey(accountId), currentUids)
      writeTimestamp(freebiesDeps.kv, lastAutoSyncAtKey(accountId), now)
      const unclaimedCount = currentUids.filter((u) => !claimed.has(u)).length
      return { reason: newUids.length > 0 ? 'changed' : 'unchanged', unclaimedCount }
    }
  )

  ipcMain.handle('library:sync', async (): Promise<{ ok: boolean; error?: string }> => {
    const token = session.getAccessToken()
    const state = session.getState()
    if (token === null || state.status !== 'authenticated') {
      return { ok: false, error: 'Not authenticated.' }
    }

    const sendProgress = (p: SyncProgress): void => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('library:sync-progress', p)
      }
    }

    const sendLog = (line: string): void => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('library:sync-log', line)
      }
    }

    // Defensive: wipe the partition's HTTP response cache at the start of
    // every manual sync so library-API responses are re-fetched from origin
    // rather than served stale from Chromium's cache. Cookies + CF clearance
    // state are untouched (`clearCache` only evicts response bodies). Note:
    // this does NOT solve the case where Fab's library endpoint itself serves
    // stale `images[0].url` for assets whose listing was recently edited —
    // that needs a per-listing detail fetch (planned 0.3.0). Failure is
    // silently swallowed; the sync is best-effort independent of this.
    try {
      await electronSession.fromPartition(FAB_SYNC_PARTITION).clearCache()
    } catch {
      /* best-effort, not worth surfacing to the user */
    }

    try {
      const result = await sync.syncAll(token, state.accountId, sendProgress, sendLog)
      if (result.vault.error || result.fab.error) {
        const combined = [result.vault.error, result.fab.error].filter(Boolean).join('; ')
        return { ok: false, error: combined }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Per-asset thumbnail / metadata refresh. Calls Fab's public listing-detail
   * endpoint (`/i/listings/<uid>`) — the same one fab.com's listing page uses —
   * so we get the authoritative current image even when the library endpoint
   * is still serving a stale cached snapshot. Only Fab assets are supported;
   * Vault / Legacy callers receive `ok: false` with an explanatory error.
   */
  ipcMain.handle(
    'library:refresh-asset-from-fab',
    async (
      _e,
      source: AssetSource,
      sourceId: string
    ): Promise<{ ok: boolean; imageUrl?: string | null; error?: string }> => {
      return await sync.refreshAssetFromFab(source, sourceId)
    }
  )

}

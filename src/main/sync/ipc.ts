import { ipcMain, session as electronSession, type BrowserWindow } from 'electron'
import type { AssetsRepo, AssetSource } from '../db/assets-repo'
import type { Sync, SyncProgress } from './sync'
import type { Session } from '../auth/session'
import type { EpicWebSessionFactory } from '../auth/epic-web-session'
import type { FabSessionClient } from '../fab/fab-session'
import { FabFreebiesClient, type FabFreebie } from '../fab/fab-freebies'
import type { KvStore } from '../db/kv'

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
  /** Used to persist auto-sync throttle state (`freebies.lastAutoSyncAt`,
   *  `freebies.lastSeenUids`) and to read settings inside IPC handlers. */
  kv: KvStore
}

/**
 * Walk the local assets cache and return the set of Fab listing uids the
 * user already owns. Two sources contribute:
 *   1. `subSource = 'fab-other'` rows store the listing uid directly as
 *      `sourceId`.
 *   2. `subSource = 'fab-ue'` rows carry the listing uid in `productUrl`
 *      (always shaped as `https://www.fab.com/listings/<uid>`), since the
 *      `sourceId` there is the Fab `assetId`, not the listing.
 *
 * `customAttributes.ListingIdentifier` from the raw payload is also harvested
 * because the productUrl fallback (when ListingIdentifier is missing) uses
 * `item.url`'s tail, which is sometimes a slug rather than a uid.
 */
function collectOwnedFabListingIds(repo: AssetsRepo): Set<string> {
  const out = new Set<string>()
  const fabAssets = repo.list({ source: 'fab', includeHidden: true })
  for (const a of fabAssets) {
    if (a.subSource === 'fab-other') {
      out.add(a.sourceId)
      continue
    }
    if (a.productUrl) {
      const m = /\/listings\/([^/?#]+)/.exec(a.productUrl)
      if (m) out.add(m[1])
    }
    // Dig into the raw JSON for ListingIdentifier — the canonical Fab listing
    // uid on UE library items. Falling back to the productUrl tail (a slug)
    // would make the cross-ref miss for items whose URL doesn't include a uid.
    if (a.raw) {
      try {
        const raw = JSON.parse(a.raw) as {
          customAttributes?: Array<{ ListingIdentifier?: string }>
        }
        if (raw.customAttributes) {
          for (const attr of raw.customAttributes) {
            if (typeof attr.ListingIdentifier === 'string') {
              out.add(attr.ListingIdentifier)
            }
          }
        }
      } catch {
        // raw is opaque per source — silently skip malformed rows.
      }
    }
  }
  return out
}

/**
 * Build the list of identifiers a freebie might match an owned asset by.
 * The Fab blade response, the `tile` wrapper and the inner `listing` object
 * all carry their own potentially-different uids; pulling them all gives
 * the cross-ref the best chance of finding a match.
 */
function collectFreebieCandidateIds(f: FabFreebie): string[] {
  const ids = new Set<string>()
  if (f.uid) ids.add(f.uid)
  // Walk top-level string values looking for `/listings/<id>/` patterns.
  for (const [, v] of Object.entries(f)) {
    if (typeof v === 'string') {
      const m = /\/listings\/([^/?#]+)/.exec(v)
      if (m) ids.add(m[1])
    }
  }
  // The nested listing object often carries the canonical uid.
  const listing = (f as Record<string, unknown>).listing
  if (listing && typeof listing === 'object') {
    const l = listing as Record<string, unknown>
    for (const key of ['uid', 'id', 'listingId', 'legacyAssetId', 'legacyItemId']) {
      const v = l[key]
      if (typeof v === 'string' && v.length > 0) ids.add(v)
    }
    if (typeof l.url === 'string') {
      const m = /\/listings\/([^/?#]+)/.exec(l.url)
      if (m) ids.add(m[1])
    }
  }
  return [...ids]
}

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
   * to the network if missing/forced, and performs the local cross-reference
   * so the returned items carry an authoritative `claimed` flag.
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
      // Local cross-reference: the Fab `/me/listings-states` endpoint is
      // flaky for some session shapes (401 on otherwise-cleared sessions),
      // so we also walk the local assets table and mark any freebie whose
      // listing uid we already own as claimed. This catches anything the
      // server check missed and reflects what the user actually has after
      // their last library sync.
      const ownedListingIds = collectOwnedFabListingIds(repo)
      let localMatches = 0
      for (const f of freebies) {
        if (f.claimed === true) continue
        const candidates = collectFreebieCandidateIds(f)
        for (const id of candidates) {
          if (ownedListingIds.has(id)) {
            f.claimed = true
            localMatches++
            break
          }
        }
      }
      console.warn(
        `[freebies] cross-ref: ${ownedListingIds.size} owned fab listing ids, ${localMatches}/${freebies.length} freebies matched locally`
      )
      if (localMatches === 0 && freebies.length > 0) {
        for (const f of freebies) {
          console.warn(`[freebies] freebie "${f.title}" candidates:`, collectFreebieCandidateIds(f))
        }
        console.warn('[freebies] sample owned ids:', [...ownedListingIds].slice(0, 5))
      }
      const fetchedAt = Date.now()
      freebiesCache = { freebies, fetchedAt }
      return { ok: true, freebies, fetchedAt }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // The cache is account-scoped (the local cross-ref reads `repo`'s owned
  // listing ids, which already account-filter). Stale entries from the
  // previous account would leak the wrong "claimed" flags into the new
  // session, so wipe the cache whenever the active account changes.
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

  /**
   * Startup-only "should we auto-refresh the library because freebies look
   * stale?" probe. The renderer calls this once on every app launch and
   * acts on the returned reason:
   *
   *   - `synced`        → a background library sync was just kicked.
   *   - `within-cap`    → too soon since the last auto-sync (>= 7 days),
   *                       no new batch detected; skip.
   *   - `all-claimed`   → freebies cross-ref says every monthly item is
   *                       already owned locally; nothing to recheck.
   *   - `not-authenticated` → no active account; nothing to do.
   *
   * The trigger fires only when AT LEAST ONE of:
   *   - It's been ≥ 7 days since the last auto-sync, OR
   *   - The freebies UID set changed vs the last seen set (new batch), OR
   *   - Today is Tuesday between 14:00 and 22:00 UTC and ≥ 24 h elapsed.
   *
   * Manual user-triggered syncs (Assets tab "Sync now", Freebies "Refresh")
   * bypass this entirely.
   */
  const KV_LAST_AUTO_SYNC_AT = 'freebies.lastAutoSyncAt'
  const KV_LAST_SEEN_UIDS = 'freebies.lastSeenUids'

  function shouldAutoSync(currentUids: string[], lastAutoSyncAt: number | null): boolean {
    const now = Date.now()
    if (lastAutoSyncAt === null) return true
    const elapsedDays = (now - lastAutoSyncAt) / 86_400_000
    if (elapsedDays >= 7) return true
    // New batch heuristic: UID set differs from the one we last saw.
    const lastUidsRaw = freebiesDeps.kv.get(KV_LAST_SEEN_UIDS)
    if (lastUidsRaw !== null) {
      try {
        const lastUids = JSON.parse(lastUidsRaw) as string[]
        const currentSet = new Set(currentUids)
        const lastSet = new Set(lastUids)
        if (
          currentSet.size !== lastSet.size ||
          [...currentSet].some((u) => !lastSet.has(u))
        ) {
          return true
        }
      } catch {
        /* malformed — treat as missing */
      }
    }
    // Tuesday-window bypass (Fab drops most often on Tuesdays). Window is
    // 14:00-22:00 UTC ≈ 16:00-24:00 CEST / 15:00-23:00 CET. Guard with a
    // 24 h minimum gap so we don't re-fire the same Tuesday twice.
    const d = new Date(now)
    const isTuesdayWindow =
      d.getUTCDay() === 2 && d.getUTCHours() >= 14 && d.getUTCHours() <= 22
    if (isTuesdayWindow && now - lastAutoSyncAt >= 24 * 3600 * 1000) {
      return true
    }
    return false
  }

  ipcMain.handle(
    'library:freebies-auto-check',
    async (): Promise<{
      reason: 'synced' | 'within-cap' | 'all-claimed' | 'not-authenticated'
      unclaimedCount: number
    }> => {
      const token = session.getAccessToken()
      const state = session.getState()
      if (token === null || state.status !== 'authenticated') {
        return { reason: 'not-authenticated', unclaimedCount: 0 }
      }
      // Fetch freebies (uses the in-process 5 min cache).
      const r = await fetchFreebies({ force: false })
      const freebies = r.ok && r.freebies ? r.freebies : []
      const currentUids = freebies.map((f) => f.uid).filter((u) => u.length > 0)
      // Stamp the latest UID set so the next launch can detect a new batch.
      freebiesDeps.kv.set(KV_LAST_SEEN_UIDS, JSON.stringify(currentUids))
      const unclaimedCount = freebies.filter((f) => f.claimed !== true).length
      if (unclaimedCount === 0) {
        return { reason: 'all-claimed', unclaimedCount: 0 }
      }
      const lastAutoSyncAtStr = freebiesDeps.kv.get(KV_LAST_AUTO_SYNC_AT)
      const lastAutoSyncAt =
        lastAutoSyncAtStr === null ? null : Number(lastAutoSyncAtStr) || null
      if (!shouldAutoSync(currentUids, lastAutoSyncAt)) {
        return { reason: 'within-cap', unclaimedCount }
      }
      // Kick a full library sync in the background — same code path as the
      // user-triggered "Sync now" button. Renderer doesn't wait for it; the
      // existing `library:sync-progress` broadcast surfaces the work, and the
      // freebies badge auto-refreshes once the cross-reference re-runs.
      freebiesDeps.kv.set(KV_LAST_AUTO_SYNC_AT, String(Date.now()))
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
      void sync
        .syncAll(token, state.accountId, sendProgress, sendLog)
        .catch((err) => console.warn('[freebies] auto-sync failed:', err))
      return { reason: 'synced', unclaimedCount }
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

    try {
      const result = await sync.syncAll(token, state.accountId, sendProgress, sendLog)
      if (result.vault.error || result.fab.error) {
        const combined = [result.vault.error, result.fab.error].filter(Boolean).join('; ')
        return { ok: false, error: combined }
      }
      // Manual sync just landed fresh image URLs (and other catalog fields)
      // into the DB. Wipe Chromium's HTTP cache so the renderer's <img> tags
      // actually fetch the new bytes — Fab / Epic often keep the URL stable
      // while updating the file on the CDN, so without a cache flush the
      // user would keep seeing the stale image even after the round-trip.
      // Side effect: other cached responses re-fetch on next access; trivial
      // cost for a user-initiated sync.
      try {
        await electronSession.defaultSession.clearCache()
      } catch (err) {
        // Cache flush is best-effort. A failure here doesn't invalidate the
        // sync — the DB is already up to date, we just won't dodge the
        // stale-image edge case until the user reloads the window.
        sendLog(
          `[warn] image cache flush failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

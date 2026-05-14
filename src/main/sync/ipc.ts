import { ipcMain, type BrowserWindow } from 'electron'
import type { AssetsRepo, AssetSource } from '../db/assets-repo'
import type { Sync, SyncProgress } from './sync'
import type { Session } from '../auth/session'
import type { EpicWebSessionFactory } from '../auth/epic-web-session'
import type { FabSessionClient } from '../fab/fab-session'
import { FabFreebiesClient, type FabFreebie } from '../fab/fab-freebies'

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
  ipcMain.handle('library:list', (_e, query: LibraryQuery): LibraryListResult => {
    return {
      assets: repo.list(query),
      countsBySource: repo.countBySource(),
      availableListingTypes: repo.availableListingTypes(),
      availableCategories: repo.availableCategories(),
      lastSync: sync.getLastSyncState()
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
        const epicSession = await freebiesDeps.epicWebSessionFactory.create(token)
        const { cookieHeader } = await freebiesDeps.fabSessionClient.establishSession(
          token,
          epicSession
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
          // For each freebie try every plausible identifier — the Fab blade
          // response uses one shape, the UE library endpoint uses another,
          // and we want a match on any common ground.
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
          // Diagnostic dump: show every candidate id per freebie + a sample
          // of the owned-ids set so the mismatch is concrete in the log.
          for (const f of freebies) {
            console.warn(`[freebies] freebie "${f.title}" candidates:`, collectFreebieCandidateIds(f))
          }
          console.warn(
            '[freebies] sample owned ids:',
            [...ownedListingIds].slice(0, 5)
          )
        }
        const fetchedAt = Date.now()
        freebiesCache = { freebies, fetchedAt }
        return { ok: true, freebies, fetchedAt }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
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
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

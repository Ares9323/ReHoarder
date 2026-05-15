import { downloadsStore } from './downloads.svelte'
import { vaultStore } from './vault.svelte'

// Local mirrors of preload types (see auth.svelte.ts for rationale).
type AssetSource = 'vault' | 'fab' | 'legacy'
type AssetSubSource = 'fab-ue' | 'fab-other' | null

/**
 * The Source dropdown supports a few values that aren't real `assets.source`
 * rows: `bookmarks` and `hidden` are filter shortcuts, and `fab-ue` / `fab-other`
 * narrow within `source = 'fab'`. The store maps each value to the right
 * combination of backend filter flags when calling `library:list`.
 */
type SourceFilter =
  | 'all'
  | 'fab-ue'
  | 'fab-other'
  | 'bookmarks'
  | 'hidden'
  | 'downloaded'
  | 'updatable'

interface AssetRow {
  source: AssetSource
  sourceId: string
  subSource: AssetSubSource
  listingType: string | null
  title: string
  description: string | null
  imageUrl: string | null
  productUrl: string | null
  ownedAt: number | null
  hidden: boolean
  bookmarked: boolean
  seller: string | null
  raw: string | null
  syncedAt: number
}

interface LibraryListResult {
  assets: AssetRow[]
  countsBySource: Record<string, number>
  availableListingTypes: string[]
  availableCategories: string[]
  lastSync: Record<string, { at: number; status: string; error: string | null }>
}

type SyncPhase = 'starting' | 'vault' | 'fab' | 'done' | 'error'

interface SyncProgress {
  phase: SyncPhase
  vaultCount: number
  fabCount: number
  total: number
  error?: string
}

export interface LibraryStore {
  readonly assets: AssetRow[]
  readonly countsBySource: Record<string, number>
  readonly availableListingTypes: string[]
  readonly availableCategories: string[]
  readonly lastSync: Record<string, { at: number; status: string; error: string | null }>
  readonly search: string
  readonly sourceFilter: SourceFilter
  /** `''` = no filter; otherwise a slug like `'3d-model'`. */
  readonly listingTypeFilter: string
  /** `''` = no filter; otherwise a category slug from `availableCategories`. */
  readonly categoryFilter: string
  readonly syncBusy: boolean
  readonly syncProgress: SyncProgress | null
  readonly syncError: string | null
  readonly syncLog: string[]
  /** True until the first refresh() completes. Distinguishes "actually empty"
   * from "still loading initial data" so the UI can show a loader instead
   * of the empty-library CTA on first paint. */
  readonly initialLoading: boolean
  setSearch(s: string): void
  setSourceFilter(f: SourceFilter): void
  setListingTypeFilter(t: string): void
  setCategoryFilter(c: string): void
  refresh(): Promise<void>
  setHidden(asset: AssetRow, hidden: boolean): Promise<void>
  setBookmarked(asset: AssetRow, bookmarked: boolean): Promise<void>
  startSync(): Promise<void>
  clearSyncLog(): void
}

export function createLibraryStore(): LibraryStore {
  // `rawAssets` is what the backend returned for the current filter set;
  // `assets` derives off it and optionally intersects with the downloaded set
  // so the "Only downloaded" Source-filter value is a client-side narrowing.
  let rawAssets = $state<AssetRow[]>([])
  const assets = $derived.by(() => {
    if (sourceFilter === 'updatable') {
      // An asset is "updatable" when at least one of our `status='done'`
      // downloads has a `buildVersion` that differs from the corresponding
      // `projectVersions[i].buildVersion` in the live raw payload. Legacy
      // downloads (no buildVersion recorded) are conservatively ignored —
      // we can't tell if they're stale.
      const buildsByAsset = new Map<string, Map<string, string>>()
      for (const r of downloadsStore.all) {
        if (r.status !== 'done' || !r.buildVersion) continue
        const key = `${r.source}:${r.sourceId}`
        const slug = (r.engineVersion ?? '*').toLowerCase()
        let m = buildsByAsset.get(key)
        if (!m) {
          m = new Map()
          buildsByAsset.set(key, m)
        }
        m.set(slug, r.buildVersion)
      }
      return rawAssets.filter((a) => {
        const builds = buildsByAsset.get(`${a.source}:${a.sourceId}`)
        if (!builds || !a.raw) return false
        let parsed: {
          projectVersions?: Array<{ engineVersions?: string[]; buildVersion?: unknown }>
        }
        try {
          parsed = JSON.parse(a.raw)
        } catch {
          return false
        }
        for (const [slug, recordedBuild] of builds) {
          if (slug === '*') continue
          for (const pv of parsed.projectVersions ?? []) {
            const evs = (pv.engineVersions ?? []).map((v) =>
              v.replace(/^UE_/i, '').toLowerCase()
            )
            if (!evs.includes(slug)) continue
            const currentBuild = typeof pv.buildVersion === 'string' ? pv.buildVersion : null
            if (currentBuild && currentBuild !== recordedBuild) return true
          }
        }
        return false
      })
    }
    if (sourceFilter !== 'downloaded') return rawAssets

    // 1) Anything ReHoarder downloaded itself — direct match against the
    //    downloads table.
    const downloaded = new Set<string>()
    for (const r of downloadsStore.all) {
      if (r.status === 'done') downloaded.add(`${r.source}:${r.sourceId}`)
    }

    // 2) Anything that's physically on disk in a vault root but predates the
    //    DB row — typically AMS / Epic Launcher downloads done before
    //    ReHoarder existed. We match on folder name == artifactId (Fab UE)
    //    or folder name == uid (Fab Other). The vault scan needs to have run
    //    at least once; if it hasn't, we just fall back to the DB set.
    if (vaultStore.entries.length > 0) {
      const vaultNames = new Set<string>()
      for (const e of vaultStore.entries) vaultNames.add(e.name.toLowerCase())
      for (const a of rawAssets) {
        const key = `${a.source}:${a.sourceId}`
        if (downloaded.has(key)) continue
        if (a.source !== 'fab' || !a.raw) continue
        try {
          const parsed = JSON.parse(a.raw) as {
            uid?: string
            projectVersions?: Array<{ artifactId?: string }>
          }
          // Fab UE: each projectVersion has its own artifactId.
          let matched = false
          for (const pv of parsed.projectVersions ?? []) {
            const aid = (pv.artifactId ?? '').toLowerCase()
            if (aid && vaultNames.has(aid)) {
              matched = true
              break
            }
          }
          // Fab Other: uid is the sourceId AND tends to be the folder name.
          if (!matched && typeof parsed.uid === 'string' && vaultNames.has(parsed.uid.toLowerCase())) {
            matched = true
          }
          if (matched) downloaded.add(key)
        } catch {
          // unparseable raw — skip
        }
      }
    }

    return rawAssets.filter((a) => downloaded.has(`${a.source}:${a.sourceId}`))
  })
  let countsBySource = $state<Record<string, number>>({})
  let availableListingTypes = $state<string[]>([])
  let availableCategories = $state<string[]>([])
  let lastSync = $state<Record<string, { at: number; status: string; error: string | null }>>({})
  let search = $state('')
  let sourceFilter = $state<SourceFilter>('all')
  let listingTypeFilter = $state('')
  let categoryFilter = $state('')
  let syncBusy = $state(false)
  let syncProgress = $state<SyncProgress | null>(null)
  let syncError = $state<string | null>(null)
  let syncLog = $state<string[]>([])
  let initialLoading = $state(true)
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

  window.api.library.onSyncProgress(async (p) => {
    syncProgress = p
    if (p.phase === 'done') {
      // Refresh the list BEFORE flipping syncBusy off, so we don't briefly
      // show the EmptyLibraryView before counts populate.
      await refresh()
      syncBusy = false
    }
  })

  window.api.library.onSyncLog((line) => {
    const ts = new Date().toLocaleTimeString()
    syncLog = [...syncLog, `[${ts}] ${line}`].slice(-500)
  })

  /** Translate the Source dropdown selection into the backend query shape. */
  function buildQuery(): {
    source?: AssetSource
    subSource?: 'fab-ue' | 'fab-other'
    listingType?: string
    category?: string
    search?: string
    includeHidden?: boolean
    onlyHidden?: boolean
    onlyBookmarked?: boolean
  } {
    const base: {
      search?: string
      listingType?: string
      category?: string
    } = { search: search.trim() === '' ? undefined : search }
    if (listingTypeFilter !== '') base.listingType = listingTypeFilter
    if (categoryFilter !== '') base.category = categoryFilter
    switch (sourceFilter) {
      case 'all':
        return { ...base }
      case 'fab-ue':
        return { ...base, source: 'fab', subSource: 'fab-ue' }
      case 'fab-other':
        return { ...base, source: 'fab', subSource: 'fab-other' }
      case 'bookmarks':
        return { ...base, onlyBookmarked: true, includeHidden: true }
      case 'hidden':
        return { ...base, onlyHidden: true }
      case 'downloaded':
        // No backend source filter — the client-side `$derived` intersects
        // with `downloadsStore.all` to keep only assets that have a
        // `status='done'` row. Other backend filters (listing type, category,
        // search) still apply as usual on top of that.
        return { ...base }
      case 'updatable':
        // Same as 'downloaded': backend returns everything; the derived
        // filters out anything whose recorded buildVersion still matches.
        return { ...base }
    }
  }

  async function refresh(): Promise<void> {
    try {
      const result: LibraryListResult = await window.api.library.list(buildQuery())
      rawAssets = result.assets
      countsBySource = result.countsBySource
      availableListingTypes = result.availableListingTypes
      availableCategories = result.availableCategories
      lastSync = result.lastSync
    } finally {
      initialLoading = false
    }
  }

  return {
    get assets() {
      return assets
    },
    get countsBySource() {
      return countsBySource
    },
    get availableListingTypes() {
      return availableListingTypes
    },
    get availableCategories() {
      return availableCategories
    },
    get lastSync() {
      return lastSync
    },
    get search() {
      return search
    },
    get sourceFilter() {
      return sourceFilter
    },
    get listingTypeFilter() {
      return listingTypeFilter
    },
    get categoryFilter() {
      return categoryFilter
    },
    get syncBusy() {
      return syncBusy
    },
    get syncProgress() {
      return syncProgress
    },
    get syncError() {
      return syncError
    },
    get syncLog() {
      return syncLog
    },
    get initialLoading() {
      return initialLoading
    },
    setSearch(s) {
      search = s
      if (searchDebounceTimer !== null) {
        clearTimeout(searchDebounceTimer)
      }
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null
        void refresh()
      }, 250)
    },
    setSourceFilter(f) {
      sourceFilter = f
      void refresh()
    },
    setListingTypeFilter(t) {
      listingTypeFilter = t
      void refresh()
    },
    setCategoryFilter(c) {
      categoryFilter = c
      void refresh()
    },
    refresh,
    async setHidden(asset, hidden) {
      await window.api.library.setHidden(asset.source, asset.sourceId, hidden)
      await refresh()
    },
    async setBookmarked(asset, bookmarked) {
      await window.api.library.setBookmarked(asset.source, asset.sourceId, bookmarked)
      await refresh()
    },
    async startSync() {
      syncBusy = true
      syncError = null
      syncLog = []
      syncProgress = { phase: 'starting', vaultCount: 0, fabCount: 0, total: 0 }
      const result = await window.api.library.sync()
      if (!result.ok) {
        syncBusy = false
        syncError = result.error ?? 'Sync failed.'
      }
    },
    clearSyncLog() {
      syncLog = []
    }
  }
}

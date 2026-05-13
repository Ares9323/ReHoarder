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
  | 'vault'
  | 'fab-ue'
  | 'fab-other'
  | 'bookmarks'
  | 'hidden'

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
  let assets = $state<AssetRow[]>([])
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
      case 'vault':
        return { ...base, source: 'vault' }
      case 'fab-ue':
        return { ...base, source: 'fab', subSource: 'fab-ue' }
      case 'fab-other':
        return { ...base, source: 'fab', subSource: 'fab-other' }
      case 'bookmarks':
        return { ...base, onlyBookmarked: true, includeHidden: true }
      case 'hidden':
        return { ...base, onlyHidden: true }
    }
  }

  async function refresh(): Promise<void> {
    try {
      const result: LibraryListResult = await window.api.library.list(buildQuery())
      assets = result.assets
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

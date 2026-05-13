// Local mirrors of preload types (see auth.svelte.ts for rationale).
type AssetSource = 'vault' | 'fab' | 'legacy'

interface AssetRow {
  source: AssetSource
  sourceId: string
  title: string
  description: string | null
  imageUrl: string | null
  productUrl: string | null
  ownedAt: number | null
  hidden: boolean
  raw: string | null
  syncedAt: number
}

interface LibraryListResult {
  assets: AssetRow[]
  countsBySource: Record<string, number>
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
  readonly lastSync: Record<string, { at: number; status: string; error: string | null }>
  readonly search: string
  readonly sourceFilter: AssetSource | 'all'
  readonly showHidden: boolean
  readonly syncBusy: boolean
  readonly syncProgress: SyncProgress | null
  readonly syncError: string | null
  readonly syncLog: string[]
  /** True until the first refresh() completes. Distinguishes "actually empty"
   * from "still loading initial data" so the UI can show a loader instead
   * of the empty-library CTA on first paint. */
  readonly initialLoading: boolean
  setSearch(s: string): void
  setSourceFilter(f: AssetSource | 'all'): void
  setShowHidden(v: boolean): void
  refresh(): Promise<void>
  setHidden(asset: AssetRow, hidden: boolean): Promise<void>
  startSync(): Promise<void>
  clearSyncLog(): void
}

export function createLibraryStore(): LibraryStore {
  let assets = $state<AssetRow[]>([])
  let countsBySource = $state<Record<string, number>>({})
  let lastSync = $state<Record<string, { at: number; status: string; error: string | null }>>({})
  let search = $state('')
  let sourceFilter = $state<AssetSource | 'all'>('all')
  let showHidden = $state(false)
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

  async function refresh(): Promise<void> {
    try {
      const result: LibraryListResult = await window.api.library.list({
        source: sourceFilter === 'all' ? undefined : sourceFilter,
        search: search.trim() === '' ? undefined : search,
        includeHidden: showHidden
      })
      assets = result.assets
      countsBySource = result.countsBySource
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
    get lastSync() {
      return lastSync
    },
    get search() {
      return search
    },
    get sourceFilter() {
      return sourceFilter
    },
    get showHidden() {
      return showHidden
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
    setShowHidden(v) {
      showHidden = v
      void refresh()
    },
    refresh,
    async setHidden(asset, hidden) {
      await window.api.library.setHidden(asset.source, asset.sourceId, hidden)
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

type DLRow = Awaited<ReturnType<typeof window.api.downloads.list>>['rows'][number]

// Module-level $state. The listener attachments below run **once per app
// session** (the module's top-level code only executes the first time it's
// imported), so Asset cards remounting on tab switch don't pile up duplicate
// listeners and don't re-fetch the list from the main process.
let allDownloads = $state<DLRow[]>([])
let loading = $state(false)
let loaded = $state(false)
let error = $state<string | null>(null)

async function fetchOnce(): Promise<void> {
  if (loaded || loading) return
  loading = true
  error = null
  try {
    const r = await window.api.downloads.list()
    allDownloads = r.rows
    loaded = true
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    loading = false
  }
}

// Live updates: the main process broadcasts the full snapshot on state-changed
// (enqueue, status flip, removed row, …) and a single-row patch on progress
// ticks (~5 Hz throttled). Both keep `allDownloads` in sync without forcing
// the renderer to re-IPC.
window.api.downloads.onStateChanged((rows) => {
  allDownloads = rows
  loaded = true
})
window.api.downloads.onProgress((row) => {
  const idx = allDownloads.findIndex((r) => r.id === row.id)
  if (idx >= 0) {
    const next = allDownloads.slice()
    next[idx] = row
    allDownloads = next
  }
})

/**
 * Singleton view of the `downloads` table. Subscribers (Asset cards, the
 * Downloads tab, the TabBar badge, the Vault tab's friendly-name overlay)
 * read off the same array — no per-component fetch needed.
 */
export const downloadsStore = {
  get all(): DLRow[] {
    return allDownloads
  },
  get loading(): boolean {
    return loading
  },
  get loaded(): boolean {
    return loaded
  },
  get error(): string | null {
    return error
  },
  async ensureLoaded(): Promise<void> {
    if (loaded || loading) return
    await fetchOnce()
  },
  async rescan(): Promise<void> {
    loaded = false
    await fetchOnce()
  }
}

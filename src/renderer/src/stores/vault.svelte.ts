interface LocalVaultEntry {
  name: string
  friendlyName: string | null
  imageUrl: string | null
  path: string
  rootPath: string
  totalBytes: number
  fileCount: number
  lastModified: number
  hasData: boolean
}

// Module-level $state — shared across every component that imports the store.
let entries = $state<LocalVaultEntry[]>([])
let vaultDirs = $state<string[]>([])
let loading = $state(false)
let loaded = $state(false)
let error = $state<string | null>(null)

async function fetchOnce(): Promise<void> {
  loading = true
  error = null
  try {
    const r = await window.api.vault.list()
    if (r.ok) {
      entries = r.entries ?? []
      vaultDirs = r.vaultDirs ?? []
      loaded = true
    } else {
      error = r.error ?? 'Failed to list vault'
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    loading = false
  }
}

/**
 * Singleton store backing the Vault tab. The expensive filesystem walk runs
 * **only**:
 *   - once on first `ensureLoaded()` (the first time the tab is opened),
 *   - whenever Settings save fires (vault paths may have changed → callers re-fetch via `rescan()`),
 *   - when the user explicitly hits the Rescan button.
 *
 * Switching back to the tab a second time hits the cache and renders instantly.
 */
export const vaultStore = {
  get entries(): LocalVaultEntry[] {
    return entries
  },
  get vaultDirs(): string[] {
    return vaultDirs
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
    await fetchOnce()
  },
  /**
   * Optimistically drop the entry at `absolutePath` from the in-memory list
   * so the UI updates instantly after a destructive op, then kick off a
   * background rescan to reconcile sizes / counts. Path comparison is
   * case-insensitive on Windows-friendly normalised forward-slash form so
   * the caller doesn't have to worry about backslashes.
   */
  removeEntryOptimistic(absolutePath: string): void {
    const key = absolutePath.replace(/\\/g, '/').toLowerCase()
    entries = entries.filter(
      (e) => e.path.replace(/\\/g, '/').toLowerCase() !== key
    )
    void fetchOnce()
  },
  /** Used after destructive ops (e.g. delete from vault) when we know the cache is stale. */
  invalidate(): void {
    loaded = false
  }
}

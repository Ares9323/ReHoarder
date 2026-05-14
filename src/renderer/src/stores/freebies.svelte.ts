// Local mirror of the FabFreebie type from src/preload/index.d.ts.
// We can't import from preload because TS resolves to the .ts source which is
// outside this project's include scope. Keep this in sync with the preload definition.
interface FabFreebie {
  uid: string
  title: string
  imageUrl: string | null
  productUrl: string
  claimed?: boolean
  [key: string]: unknown
}

// Module-scoped reactive state: every component that imports `freebiesStore`
// shares the same array, so the TabBar badge and the FreebiesView agree on
// counts without re-fetching.
let freebies = $state<FabFreebie[]>([])
let fetchedAt = $state<number | null>(null)
let loading = $state(false)
let loaded = $state(false)
let error = $state<string | null>(null)

async function fetchOnce(force = false): Promise<void> {
  loading = true
  error = null
  try {
    const r = await window.api.library.listFreebies({ force })
    if (r.ok) {
      freebies = r.freebies ?? []
      fetchedAt = r.fetchedAt ?? Date.now()
      loaded = true
    } else {
      error = r.error ?? 'Failed to list freebies'
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    loading = false
  }
}

/**
 * Singleton store backing the Freebies tab. The Fab blade endpoint is
 * cached server-side (TTL ~5 min) so calling `ensureLoaded()` repeatedly
 * costs at most one round-trip per cache window. `refresh()` always
 * passes `force: true` to bypass the cache when the user explicitly asks.
 */
export const freebiesStore = {
  get freebies(): FabFreebie[] {
    return freebies
  },
  get fetchedAt(): number | null {
    return fetchedAt
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
  get unclaimedCount(): number {
    return freebies.filter((f) => f.claimed !== true).length
  },
  async ensureLoaded(): Promise<void> {
    if (loaded || loading) return
    await fetchOnce(false)
  },
  async refresh(): Promise<void> {
    await fetchOnce(true)
  }
}

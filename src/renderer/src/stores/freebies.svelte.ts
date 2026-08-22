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
let claimError = $state<string | null>(null)

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

/** Overwrite each freebie's `claimed` flag from the authoritative set the main
 *  process returned, so the optimistic flip and the KV truth agree. */
function reconcileClaimed(claimedUids: string[]): void {
  const set = new Set(claimedUids)
  freebies = freebies.map((f) => ({ ...f, claimed: set.has(f.uid) }))
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
  },
  get claimError(): string | null {
    return claimError
  },
  /** Toggle a single freebie's claimed flag. Optimistic: flips the local flag
   *  first so the badge/card react instantly, then reconciles from the KV set
   *  the main process returns. Rolls back on failure. */
  async markClaimed(uid: string, claimed: boolean): Promise<void> {
    claimError = null
    const prev = freebies
    freebies = freebies.map((f) => (f.uid === uid ? { ...f, claimed } : f))
    try {
      const r = await window.api.library.setFreebiesClaimed([uid], claimed)
      if (r.ok && r.claimedUids) {
        reconcileClaimed(r.claimedUids)
      } else {
        freebies = prev
        claimError = r.error ?? 'Failed to update claimed state'
      }
    } catch (err) {
      freebies = prev
      claimError = err instanceof Error ? err.message : String(err)
    }
  },
  /** Mark every currently-listed freebie as claimed in one call. */
  async markAllClaimed(): Promise<void> {
    claimError = null
    const prev = freebies
    const uids = freebies.map((f) => f.uid).filter((u) => u.length > 0)
    if (uids.length === 0) return
    freebies = freebies.map((f) => ({ ...f, claimed: true }))
    try {
      const r = await window.api.library.setFreebiesClaimed(uids, true)
      if (r.ok && r.claimedUids) {
        reconcileClaimed(r.claimedUids)
      } else {
        freebies = prev
        claimError = r.error ?? 'Failed to update claimed state'
      }
    } catch (err) {
      freebies = prev
      claimError = err instanceof Error ? err.message : String(err)
    }
  },
  /** Reset cached state so the next `ensureLoaded()` re-fetches against the
   *  new active account. Used by App.svelte on account switch — the existing
   *  list belongs to whoever was active a moment ago. */
  invalidate(): void {
    freebies = []
    fetchedAt = null
    loaded = false
    loading = false
    error = null
    claimError = null
  }
}

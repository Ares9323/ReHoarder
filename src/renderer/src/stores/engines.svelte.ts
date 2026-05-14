interface EngineInfo {
  name: string
  path: string
  version: string
  majorVersion: number
  changelist: number
  branchName: string
  editorExePath: string | null
  hasEditor: boolean
}

let engines = $state<EngineInfo[]>([])
let scannedPaths = $state<string[]>([])
let loading = $state(false)
let loaded = $state(false)
let error = $state<string | null>(null)

async function fetchOnce(): Promise<void> {
  loading = true
  error = null
  try {
    const r = await window.api.engines.list()
    if (r.ok) {
      engines = r.engines ?? []
      scannedPaths = r.scannedPaths ?? []
      loaded = true
    } else {
      error = r.error ?? 'Failed to list engines'
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    loading = false
  }
}

/**
 * Singleton store for the Engines tab. Engine scanning is cheaper than vault /
 * projects walks (just one Build.version file per UE_* folder), but we still
 * keep the cache so tab switches feel instant and we don't double-fetch when
 * other views (e.g. Custom Install menu) ask for the engine list.
 */
export const enginesStore = {
  get engines(): EngineInfo[] {
    return engines
  },
  get scannedPaths(): string[] {
    return scannedPaths
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
  invalidate(): void {
    loaded = false
  }
}

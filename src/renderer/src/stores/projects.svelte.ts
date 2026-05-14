interface ProjectInfo {
  name: string
  uprojectPath: string
  projectDir: string
  rootPath: string
  engineAssociation: string
  description: string
  category: string
  hasCode: boolean
  lastModified: number
  rehoarderSource: string | null
  rehoarderSourceId: string | null
  imageUrl: string | null
}

let projects = $state<ProjectInfo[]>([])
let scannedPaths = $state<string[]>([])
let loading = $state(false)
let loaded = $state(false)
let error = $state<string | null>(null)

async function fetchOnce(): Promise<void> {
  loading = true
  error = null
  try {
    const r = await window.api.projects.list()
    if (r.ok) {
      projects = r.projects ?? []
      scannedPaths = r.scannedPaths ?? []
      loaded = true
    } else {
      error = r.error ?? 'Failed to list projects'
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    loading = false
  }
}

/**
 * Singleton store for the Projects tab. Same lazy-load pattern as `vaultStore`:
 * the recursive `.uproject` scan runs only on first access, on Settings save,
 * or on explicit Rescan. Tab switches don't re-walk the filesystem.
 */
export const projectsStore = {
  get projects(): ProjectInfo[] {
    return projects
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

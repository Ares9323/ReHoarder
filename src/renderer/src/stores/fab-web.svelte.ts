import type { FabWebStatus } from '../lib/fab-web-chip'

/** Sync log line emitted when entitlements were skipped for lack of a fab.com session. */
const NOT_SIGNED_IN_PREFIX = 'Fab: not signed in to fab.com'

// Module-scoped reactive state shared by every importer (Assets header chip).
let status = $state<FabWebStatus | null>(null)
let busy = $state(false)
let attention = $state(false)

async function refresh(): Promise<void> {
  try {
    status = await window.api.library.fabWebStatus()
  } catch {
    status = 'unknown'
  }
}

/**
 * Singleton store for the fab.com web session status shown next to
 * "Sync now". `signIn()` runs the interactive login (silent first, then the
 * visible "Sign in to Fab" window).
 */
export const fabWebStore = {
  get status(): FabWebStatus | null {
    return status
  },
  get busy(): boolean {
    return busy
  },
  get attention(): boolean {
    return attention
  },
  refresh,
  async signIn(): Promise<void> {
    if (busy) return
    busy = true
    try {
      status = await window.api.library.fabWebLogin()
      if (status === 'logged-in') attention = false
    } catch {
      status = 'unknown'
    } finally {
      busy = false
    }
  },
  /** Called once a sync finished, with its log: flags the chip when entitlements were skipped. */
  afterSync(syncLog: string[]): void {
    attention = syncLog.some((l) => l.startsWith(NOT_SIGNED_IN_PREFIX))
    if (attention) status = 'logged-out'
    else void refresh()
  },
  /** Account switch: the partition cookies were reset, forget the old status. */
  reset(): void {
    status = null
    attention = false
    void refresh()
  }
}

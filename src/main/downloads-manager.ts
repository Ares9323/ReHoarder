import { randomUUID } from 'node:crypto'
import type { DownloadRow, DownloadsRepo } from './db/downloads-repo'
import type { FabRunnerDeps } from './download/fab-asset-runner'
import { runFabAssetDownload } from './download/fab-asset-runner'
import type { SettingsStore } from './settings'
import { DownloadCancelledError } from './download/download-types'

export interface DownloadsManagerDeps {
  repo: DownloadsRepo
  settings: SettingsStore
  /** Dependencies needed by the Fab runner (auth, session, fetch, repo). */
  runner: FabRunnerDeps
  /** Broadcast a full list snapshot to every renderer. Called after every meaningful state change. */
  broadcast: (rows: DownloadRow[]) => void
  /** Optional broadcast for fine-grained progress (decoupled from the full list refresh). */
  broadcastProgress?: (id: string, row: DownloadRow) => void
}

/**
 * Single-flight queue: at most one download runs at a time. Progress and
 * status are persisted in the `downloads` table, so the queue survives
 * restarts (interrupted rows are bumped back to `queued` on startup).
 */
export class DownloadsManager {
  private currentId: string | null = null
  private currentAbort: AbortController | null = null
  /** When `true`, picking up the next queued item is skipped. Used when the orchestrator is shutting down. */
  private stopped = false
  /** Throttle progress broadcasts to ~5/s — chunk-grained updates would otherwise hammer IPC. */
  private lastProgressBroadcastAt = 0

  constructor(private readonly deps: DownloadsManagerDeps) {}

  /** Called at startup, before the renderer connects. Recovers state from previous run. */
  bootstrap(): void {
    const recovered = this.deps.repo.resetInterrupted()
    if (recovered > 0) {
      console.warn(`[downloads] recovered ${recovered} interrupted download(s) → queued`)
    }
    // Pump the queue (fire-and-forget; UI doesn't need to wait).
    void this.pump()
  }

  list(): DownloadRow[] {
    return this.deps.repo.listAll()
  }

  enqueue(source: string, sourceId: string, title: string): DownloadRow {
    const row = this.deps.repo.insert({
      id: randomUUID(),
      source,
      sourceId,
      title,
      status: 'queued',
      bytesDone: 0,
      bytesTotal: 0,
      filesDone: 0,
      filesTotal: 0,
      createdAt: Date.now()
    })
    this.notify()
    void this.pump()
    return row
  }

  cancel(id: string): boolean {
    const row = this.deps.repo.findById(id)
    if (!row) return false
    if (row.status === 'queued') {
      this.deps.repo.setStatus(id, 'cancelled', { finishedAt: Date.now() })
      this.notify()
      return true
    }
    if (row.status === 'running' && this.currentId === id && this.currentAbort) {
      this.currentAbort.abort()
      // Final state transition happens inside `pump()` once the orchestrator throws.
      return true
    }
    return false
  }

  /** Re-queue a `failed` or `cancelled` row at the back of the queue. */
  retry(id: string): boolean {
    const row = this.deps.repo.findById(id)
    if (!row) return false
    if (row.status !== 'failed' && row.status !== 'cancelled') return false
    this.deps.repo.setStatus(id, 'queued', {
      bytesDone: 0,
      filesDone: 0,
      currentFile: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      // refresh `created_at` so retries go to the back of the FIFO
      createdAt: Date.now()
    })
    this.notify()
    void this.pump()
    return true
  }

  /** Delete a row from history. Refuses to remove an in-flight download. */
  remove(id: string): boolean {
    const row = this.deps.repo.findById(id)
    if (!row) return false
    if (row.status === 'running') return false
    this.deps.repo.remove(id)
    this.notify()
    return true
  }

  /** Drop every row in a terminal status. */
  clearCompleted(): number {
    const n = this.deps.repo.removeCompleted()
    if (n > 0) this.notify()
    return n
  }

  /** Tell the manager to stop accepting new pumps. Called at app shutdown. */
  stop(): void {
    this.stopped = true
    if (this.currentAbort) this.currentAbort.abort()
  }

  private notify(): void {
    this.deps.broadcast(this.list())
  }

  private async pump(): Promise<void> {
    if (this.stopped) return
    if (this.currentId !== null) return // already running one
    const next = this.deps.repo.nextQueued()
    if (!next) return

    const cfg = this.deps.settings.load()
    const vaultDir = cfg.vaultPaths[0]
    if (!vaultDir) {
      this.deps.repo.setStatus(next.id, 'failed', {
        error: 'No vault path configured — set one under Settings → Vault paths.',
        finishedAt: Date.now()
      })
      this.notify()
      // try the next one — maybe it doesn't share this issue (it does, but the loop is harmless)
      void this.pump()
      return
    }

    this.currentId = next.id
    this.currentAbort = new AbortController()
    this.deps.repo.setStatus(next.id, 'running', {
      startedAt: Date.now(),
      error: null
    })
    this.notify()

    try {
      await runFabAssetDownload(
        this.deps.runner,
        next.sourceId,
        {
          vaultDir,
          signal: this.currentAbort.signal,
          onLog: (m) => console.warn(`[downloads:${next.id.slice(0, 8)}]`, m),
          onProgress: (p) => {
            this.deps.repo.updateProgress(
              next.id,
              p.bytesDone,
              p.bytesTotal,
              p.filesDone,
              p.filesTotal,
              p.currentFile
            )
            const now = Date.now()
            if (now - this.lastProgressBroadcastAt > 200) {
              this.lastProgressBroadcastAt = now
              const fresh = this.deps.repo.findById(next.id)
              if (fresh) this.deps.broadcastProgress?.(next.id, fresh)
            }
          }
        },
        (startInfo) => {
          this.deps.repo.setStatus(next.id, 'running', {
            destDir: startInfo.assetDir,
            bytesTotal: startInfo.bytesTotal,
            filesTotal: startInfo.filesTotal
          })
          this.notify()
        }
      )
      this.deps.repo.setStatus(next.id, 'done', { finishedAt: Date.now(), currentFile: null })
    } catch (err) {
      const cancelled = err instanceof DownloadCancelledError
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.repo.setStatus(next.id, cancelled ? 'cancelled' : 'failed', {
        finishedAt: Date.now(),
        error: cancelled ? null : msg,
        currentFile: null
      })
      if (!cancelled) {
        console.error(`[downloads:${next.id.slice(0, 8)}] failed:`, msg)
      }
    } finally {
      this.currentId = null
      this.currentAbort = null
      this.notify()
      // Tail-call the next item, if any.
      void this.pump()
    }
  }
}

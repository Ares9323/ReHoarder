import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { DownloadRow, DownloadsRepo } from './db/downloads-repo'
import type { FabRunnerDeps } from './download/fab-asset-runner'
import { runFabAssetDownload } from './download/fab-asset-runner'
import { scanEngines } from './engines-local'
import type { SettingsStore } from './settings'
import { DownloadCancelledError } from './download/download-types'

export interface EnqueueOptions {
  /** Short engine version slug (e.g. `5.4`). Used to pick the matching `projectVersion[]` from the asset raw JSON. */
  engineVersion?: string
  /** Absolute destination override. When set, the asset is unpacked under this path instead of the configured vault root. */
  installTargetPath?: string
}

/**
 * Identify how a user-supplied `installTargetPath` is structured, so the pump
 * loop knows whether to strip the manifest's engine-relative path prefix.
 * Convention used by `CustomInstallMenu`:
 *   - Engine install   → `<engine>/Engine/Plugins/Marketplace`
 *   - Project install  → `<project>/Plugins`
 *   - Anything else    → treat as a flat vault directory
 */
function classifyInstallTarget(p: string | null): 'engine' | 'project' | 'vault' | null {
  if (!p) return null
  const normalised = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  if (normalised.endsWith('/engine/plugins/marketplace')) return 'engine'
  if (normalised.endsWith('/plugins')) return 'project'
  return 'vault'
}

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

  enqueue(
    source: string,
    sourceId: string,
    title: string,
    opts: EnqueueOptions = {}
  ): DownloadRow {
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
      engineVersion: opts.engineVersion ?? null,
      installTargetPath: opts.installTargetPath ?? null,
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

  /**
   * When a Fab UE asset is a CODE_PLUGIN AND the user has the matching engine
   * installed, drop the install under `<engine>/Engine/Plugins/Marketplace/<plugin>/`
   * instead of the vault path. Returns null for anything that should fall
   * through to the normal vault destination (non-plugin assets, missing engine,
   * non-Fab sources).
   */
  private async resolvePluginEngineRoute(
    row: DownloadRow,
    enginePaths: string[]
  ): Promise<{ vaultDir: string; subdir: string } | null> {
    if (row.source !== 'fab' || !row.engineVersion) return null
    const asset = this.deps.runner.assetsRepo.findById('fab', row.sourceId)
    if (!asset?.raw) return null
    let raw: { distributionMethod?: string }
    try {
      raw = JSON.parse(asset.raw) as { distributionMethod?: string }
    } catch {
      return null
    }
    if (raw.distributionMethod !== 'CODE_PLUGIN') return null

    const engines = await scanEngines(enginePaths)
    const ev = row.engineVersion
    const engine = engines.find((e) => e.version.split('.').slice(0, 2).join('.') === ev)
    if (!engine) return null
    const vaultDir = path.join(engine.path, 'Engine', 'Plugins', 'Marketplace')
    // The plugin folder name is derived from the asset title — sanitised the
    // same way the runner sanitises subdirs, but more specific than the raw
    // artifactId since the .uplugin file inside needs a stable name.
    const subdir = row.title.replace(/[/\\:*?"<>|]/g, '_').trim() || row.sourceId
    return { vaultDir, subdir }
  }

  private async pump(): Promise<void> {
    if (this.stopped) return
    if (this.currentId !== null) return // already running one
    const next = this.deps.repo.nextQueued()
    if (!next) return

    const cfg = this.deps.settings.load()

    // Decide the destination ahead of the runner: explicit override > engine-plugin
    // auto-route (for CODE_PLUGIN assets with a matched engine install) > the
    // configured vault path. Auto-routing requires both `engineVersion` to be set
    // on the row AND the raw payload to declare `distributionMethod=CODE_PLUGIN`.
    //
    // For plugin installs the manifest ships engine-relative paths
    // (`Engine/Plugins/Marketplace/<plugin>/...`), so the orchestrator needs to:
    //   1. Skip the `data/` wrapper (the file tree IS the install)
    //   2. For project installs, strip the `Engine/Plugins/Marketplace/` prefix
    //      so files land under `<project>/Plugins/<plugin>/...` instead of
    //      `<project>/Plugins/Engine/Plugins/Marketplace/<plugin>/...`
    let vaultDir: string | undefined = next.installTargetPath ?? undefined
    let assetSubdirOverride: string | undefined
    let pathStripPrefix: string | undefined
    let noWrapDataDir = false

    const targetKind = classifyInstallTarget(next.installTargetPath)
    if (targetKind === 'engine') {
      // installTargetPath = `<engine>/Engine/Plugins/Marketplace`. Manifest
      // already writes its own `Engine/Plugins/Marketplace/<plugin>/...` tree,
      // so we step UP to the engine root and let the manifest paths land in
      // the right place naturally. No subdir, no data/ wrap.
      vaultDir = path.resolve(next.installTargetPath ?? '', '..', '..', '..')
      assetSubdirOverride = ''
      noWrapDataDir = true
    } else if (targetKind === 'project') {
      // installTargetPath = `<project>/Plugins`. Strip the engine-side prefix
      // so files land in `<project>/Plugins/<plugin>/...`.
      assetSubdirOverride = ''
      noWrapDataDir = true
      pathStripPrefix = 'Engine/Plugins/Marketplace/'
    } else if (!vaultDir && next.engineVersion) {
      const pluginRoute = await this.resolvePluginEngineRoute(next, cfg.enginePaths)
      if (pluginRoute) {
        // Auto-routed engine install: same handling as the explicit one.
        vaultDir = path.resolve(pluginRoute.vaultDir, '..', '..', '..')
        assetSubdirOverride = ''
        noWrapDataDir = true
      }
    }
    if (!vaultDir) vaultDir = cfg.vaultPaths[0]
    if (!vaultDir) {
      this.deps.repo.setStatus(next.id, 'failed', {
        error: 'No vault path configured — set one under Settings → Vault paths.',
        finishedAt: Date.now()
      })
      this.notify()
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
          assetSubdir: assetSubdirOverride,
          engineVersion: next.engineVersion ?? undefined,
          pathStripPrefix,
          noWrapDataDir,
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
            filesTotal: startInfo.filesTotal,
            // `buildVersion` is `Manifest.meta.buildVersion`; persisted on the row
            // so the renderer can later spot "the live raw build is newer".
            buildVersion: startInfo.buildVersion
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

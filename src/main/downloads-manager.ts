import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { DownloadRow, DownloadsRepo } from './db/downloads-repo'
import type { FabRunnerDeps } from './download/fab-asset-runner'
import { runFabAssetDownload } from './download/fab-asset-runner'
import { composeSkipPatterns } from './download/cruft-filter'
import { scanEngines } from './engines-local'
import type { AppSettings, SettingsStore } from './settings'
import { DownloadCancelledError } from './download/download-types'
import type { EngineInstallPlan } from './engine-downloads/engine-catalog-client'
import { runEngineDownload } from './engine-downloads/engine-runner'
import {
  finalizeEngineInstall,
  type PostInstallResult
} from './engine-downloads/engine-post-install'

function buildSkipPatterns(cfg: AppSettings): string[] {
  return composeSkipPatterns({
    includeCruft: cfg.skipCruftAtDownload,
    userExtras: cfg.cruftPatterns,
    includePlatformBinaries: cfg.deleteExtraVaultPlatforms
  })
}

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
  /** Fired once an engine install finishes and post-install bookkeeping
   *  (registry write + enginePaths append) has run, so the Engines tab
   *  can rescan + show a toast without polling the downloads list. */
  broadcastEngineInstalled?: (info: {
    appName: string
    installDir: string
    postInstall: PostInstallResult
  }) => void
}

/**
 * N-slot queue: up to `settings.maxConcurrentDownloads` assets run at once.
 * Progress and status are persisted in the `downloads` table, so the queue
 * survives restarts (interrupted rows are bumped back to `queued` on startup).
 */
export class DownloadsManager {
  /** Abort controllers keyed by download id for every in-flight slot. */
  private readonly running = new Map<string, AbortController>()
  /** When `true`, picking up the next queued item is skipped. Used when the orchestrator is shutting down. */
  private stopped = false
  /** Per-id throttle for progress broadcasts (~5/s each) — chunk-grained updates would otherwise hammer IPC. */
  private readonly lastProgressBroadcastAt = new Map<string, number>()
  /** Engine downloads carry an `EngineInstallPlan` (parsed manifest + signed
   *  CDN base URIs) and a `Set<string>` of selected install tags that the
   *  DB row can't model on its own. We keep them in memory keyed by row id;
   *  on app restart an interrupted engine row drops to `failed` with a hint
   *  to re-enqueue from the Engines tab (persisting the plan across restarts
   *  would mean writing the 35 MB parsed manifest to disk, which isn't worth
   *  the trade-off in v1). */
  private readonly enginePending = new Map<
    string,
    { plan: EngineInstallPlan; selectedTags: Set<string> }
  >()

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

  /**
   * Engine-specific enqueue: inserts the row with `source='engine'` and
   * `sourceId=<appName>`, then stashes the install plan + selected tags in
   * memory so `runDownload` can hand them to the engine runner. Title is
   * derived from the build version for display; install dir is mandatory.
   */
  enqueueEngine(args: {
    appName: string
    shortVersion: string
    buildVersion: string
    installDir: string
    plan: EngineInstallPlan
    selectedTags: Set<string>
  }): DownloadRow {
    const id = randomUUID()
    const title = `Unreal Engine ${args.shortVersion}`
    this.enginePending.set(id, { plan: args.plan, selectedTags: args.selectedTags })
    const row = this.deps.repo.insert({
      id,
      source: 'engine',
      sourceId: args.appName,
      title,
      status: 'queued',
      bytesDone: 0,
      bytesTotal: 0,
      filesDone: 0,
      filesTotal: 0,
      engineVersion: args.shortVersion,
      installTargetPath: args.installDir,
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
    if (row.status === 'running') {
      const ac = this.running.get(id)
      if (ac) {
        ac.abort()
        // Final state transition happens inside `runDownload()` once the orchestrator throws.
        return true
      }
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

  /** Tell the manager to stop accepting new pumps and abort every running slot. Called at app shutdown. */
  stop(): void {
    this.stopped = true
    for (const ac of this.running.values()) ac.abort()
  }

  /**
   * Notify the manager that settings may have changed. If `maxConcurrentDownloads`
   * just got bigger, this fills the newly-available slots without waiting for a
   * fresh enqueue.
   */
  onSettingsChanged(): void {
    void this.pump()
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

  /**
   * Top-level scheduler. Synchronously claims as many queued rows as fit into
   * the empty slots, then spawns a fire-and-forget `runDownload` for each.
   *
   * Claim must happen synchronously before any await: otherwise a second
   * `pump()` invocation could pick the same row out of `nextQueued()` between
   * the await points.
   */
  private async pump(): Promise<void> {
    if (this.stopped) return
    const maxSlots = this.deps.settings.load().maxConcurrentDownloads
    while (this.running.size < maxSlots) {
      const next = this.deps.repo.nextQueued()
      if (!next) return
      const ac = new AbortController()
      this.running.set(next.id, ac)
      this.deps.repo.setStatus(next.id, 'running', {
        startedAt: Date.now(),
        error: null
      })
      this.notify()
      void this.runDownload(next, ac)
    }
  }

  /**
   * One slot's worth of work: resolve the destination, run the orchestrator,
   * persist the final state, free the slot, then re-pump for the next queued
   * row. Errors and cancellations are caught and recorded — they must never
   * leak out and crash the manager.
   */
  private async runDownload(row: DownloadRow, abort: AbortController): Promise<void> {
    if (row.source === 'engine') {
      await this.runEngineRow(row, abort)
      return
    }
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
    let vaultDir: string | undefined = row.installTargetPath ?? undefined
    let assetSubdirOverride: string | undefined
    let pathStripPrefix: string | undefined
    let noWrapDataDir = false

    const targetKind = classifyInstallTarget(row.installTargetPath)
    if (targetKind === 'engine') {
      vaultDir = path.resolve(row.installTargetPath ?? '', '..', '..', '..')
      assetSubdirOverride = ''
      noWrapDataDir = true
    } else if (targetKind === 'project') {
      assetSubdirOverride = ''
      noWrapDataDir = true
      pathStripPrefix = 'Engine/Plugins/Marketplace/'
    } else if (!vaultDir && row.engineVersion) {
      const pluginRoute = await this.resolvePluginEngineRoute(row, cfg.enginePaths)
      if (pluginRoute) {
        vaultDir = path.resolve(pluginRoute.vaultDir, '..', '..', '..')
        assetSubdirOverride = ''
        noWrapDataDir = true
      }
    }
    if (!vaultDir) vaultDir = cfg.vaultPaths[0]
    if (!vaultDir) {
      this.deps.repo.setStatus(row.id, 'failed', {
        error: 'No vault path configured — set one under Settings → Vault paths.',
        finishedAt: Date.now()
      })
      this.running.delete(row.id)
      this.lastProgressBroadcastAt.delete(row.id)
      this.notify()
      void this.pump()
      return
    }

    try {
      await runFabAssetDownload(
        this.deps.runner,
        row.sourceId,
        {
          vaultDir,
          assetSubdir: assetSubdirOverride,
          engineVersion: row.engineVersion ?? undefined,
          pathStripPrefix,
          noWrapDataDir,
          skipPatterns: buildSkipPatterns(cfg),
          signal: abort.signal,
          onLog: (m) => console.warn(`[downloads:${row.id.slice(0, 8)}]`, m),
          onProgress: (p) => {
            this.deps.repo.updateProgress(
              row.id,
              p.bytesDone,
              p.bytesTotal,
              p.filesDone,
              p.filesTotal,
              p.currentFile
            )
            const now = Date.now()
            const last = this.lastProgressBroadcastAt.get(row.id) ?? 0
            if (now - last > 200) {
              this.lastProgressBroadcastAt.set(row.id, now)
              const fresh = this.deps.repo.findById(row.id)
              if (fresh) this.deps.broadcastProgress?.(row.id, fresh)
            }
          }
        },
        (startInfo) => {
          this.deps.repo.setStatus(row.id, 'running', {
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
      this.deps.repo.setStatus(row.id, 'done', { finishedAt: Date.now(), currentFile: null })
    } catch (err) {
      const cancelled = err instanceof DownloadCancelledError
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.repo.setStatus(row.id, cancelled ? 'cancelled' : 'failed', {
        finishedAt: Date.now(),
        error: cancelled ? null : msg,
        currentFile: null
      })
      if (!cancelled) {
        console.error(`[downloads:${row.id.slice(0, 8)}] failed:`, msg)
      }
    } finally {
      this.running.delete(row.id)
      this.lastProgressBroadcastAt.delete(row.id)
      this.notify()
      // Tail-call the next item, if any.
      void this.pump()
    }
  }

  /**
   * Engine-specific runner. Picks up the cached plan + selectedTags that
   * `enqueueEngine` stashed in memory, then delegates to the shared
   * chunk-download pipeline. When the cached plan is missing (e.g. row
   * survived an app restart) we fail with a clear hint.
   */
  private async runEngineRow(row: DownloadRow, abort: AbortController): Promise<void> {
    const pending = this.enginePending.get(row.id)
    if (!pending) {
      this.deps.repo.setStatus(row.id, 'failed', {
        error:
          'Engine install plan not in memory (was the app restarted mid-download?). ' +
          'Re-open Engines → Install engine… to start a fresh download.',
        finishedAt: Date.now()
      })
      this.running.delete(row.id)
      this.lastProgressBroadcastAt.delete(row.id)
      this.notify()
      void this.pump()
      return
    }
    if (!row.installTargetPath) {
      this.deps.repo.setStatus(row.id, 'failed', {
        error: 'Engine row has no install target path.',
        finishedAt: Date.now()
      })
      this.enginePending.delete(row.id)
      this.running.delete(row.id)
      this.notify()
      void this.pump()
      return
    }
    try {
      await runEngineDownload(pending.plan, {
        installDir: row.installTargetPath,
        selectedTags: pending.selectedTags,
        signal: abort.signal,
        onLog: (m) => console.warn(`[engines:${row.id.slice(0, 8)}]`, m),
        onProgress: (p) => {
          this.deps.repo.updateProgress(
            row.id,
            p.bytesDone,
            p.bytesTotal,
            p.filesDone,
            p.filesTotal,
            p.currentFile
          )
          const now = Date.now()
          const last = this.lastProgressBroadcastAt.get(row.id) ?? 0
          if (now - last > 200) {
            this.lastProgressBroadcastAt.set(row.id, now)
            const fresh = this.deps.repo.findById(row.id)
            if (fresh) this.deps.broadcastProgress?.(row.id, fresh)
          }
        },
        onStart: (startInfo) => {
          this.deps.repo.setStatus(row.id, 'running', {
            destDir: startInfo.installDir,
            bytesTotal: startInfo.bytesTotal,
            filesTotal: startInfo.filesTotal,
            buildVersion: startInfo.buildVersion
          })
          this.notify()
        }
      })
      this.deps.repo.setStatus(row.id, 'done', { finishedAt: Date.now(), currentFile: null })
      // Post-install bookkeeping: add to enginePaths + register with UVS
      // (on Windows). Failures are surfaced through the result but never
      // mark the download itself failed — the chunks are on disk and the
      // user can recover by adding the path manually.
      try {
        const postInstall = await finalizeEngineInstall(
          this.deps.settings,
          row.installTargetPath
        )
        this.deps.broadcastEngineInstalled?.({
          appName: row.sourceId,
          installDir: row.installTargetPath,
          postInstall
        })
      } catch (err) {
        console.error(
          `[engines:${row.id.slice(0, 8)}] post-install bookkeeping failed:`,
          err instanceof Error ? err.message : String(err)
        )
      }
    } catch (err) {
      const cancelled = err instanceof DownloadCancelledError
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.repo.setStatus(row.id, cancelled ? 'cancelled' : 'failed', {
        finishedAt: Date.now(),
        error: cancelled ? null : msg,
        currentFile: null
      })
      if (!cancelled) {
        console.error(`[engines:${row.id.slice(0, 8)}] failed:`, msg)
      }
    } finally {
      this.enginePending.delete(row.id)
      this.running.delete(row.id)
      this.lastProgressBroadcastAt.delete(row.id)
      this.notify()
      void this.pump()
    }
  }
}


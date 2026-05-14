import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from './db/schema'
import { DownloadsRepo } from './db/downloads-repo'
import { KvStore } from './db/kv'
import { SettingsStore } from './settings'
import type { FabRunnerDeps } from './download/fab-asset-runner'

// `DownloadsManager` imports `runFabAssetDownload` at module scope. We replace
// it with a vi.fn whose returned promise we control per-asset, so the tests
// can hold downloads "running" indefinitely and exercise the slot scheduler
// without touching the network.
const runFn = vi.fn()
vi.mock('./download/fab-asset-runner', () => ({
  runFabAssetDownload: (...args: unknown[]) => runFn(...args)
}))
// `resolvePluginEngineRoute` calls `scanEngines` when a row has engineVersion
// set. We never set engineVersion in these tests, but stub anyway to be safe.
vi.mock('./engines-local', () => ({ scanEngines: vi.fn().mockResolvedValue([]) }))
// `settings.ts` calls `app.getPath('documents')` to seed default project /
// engine / vault paths. The `electron` package is unavailable in a plain Node
// test environment, so stub the surface we need.
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => `/tmp/electron-${key}`
  }
}))

// Import after the mocks so the manager picks up the stubbed runner.
import { DownloadsManager } from './downloads-manager'

interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drain pending microtasks so chained `await` continuations get a chance to run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

let db: Database.Database
let repo: DownloadsRepo
let settings: SettingsStore
let manager: DownloadsManager
let pending: Map<string, Deferred>
let broadcastSnapshots: number

beforeEach(() => {
  db = new Database(':memory:')
  // `applySchema` runs `applyMigrations` *before* CREATE TABLE, so on a fresh
  // DB the first pass skips the engine_version / install_target_path /
  // build_version ALTER TABLEs (no table to alter yet) and CREATE TABLE then
  // builds the table without those columns. A second pass picks them up via
  // ALTER. This is how production reaches the full schema after one restart;
  // we just trigger it eagerly in the test.
  applySchema(db)
  applySchema(db)
  const kv = new KvStore(db)
  settings = new SettingsStore(kv)
  // Always seed at least one vault path so the manager doesn't short-circuit
  // to 'failed' for missing destination.
  settings.saveAll({
    vaultPaths: ['/tmp/test-vault'],
    maxConcurrentDownloads: 2
  })
  repo = new DownloadsRepo(db)

  pending = new Map()
  runFn.mockReset()
  runFn.mockImplementation((_deps, assetId: string) => {
    const d = deferred()
    pending.set(assetId, d)
    return d.promise
  })

  broadcastSnapshots = 0
  manager = new DownloadsManager({
    repo,
    settings,
    runner: {} as FabRunnerDeps,
    broadcast: () => {
      broadcastSnapshots++
    }
  })
})

describe('DownloadsManager — parallel queue scheduler', () => {
  it('runs up to maxConcurrentDownloads assets at the same time', async () => {
    manager.enqueue('fab', 'a', 'A')
    manager.enqueue('fab', 'b', 'B')
    manager.enqueue('fab', 'c', 'C')
    await flush()

    expect(runFn).toHaveBeenCalledTimes(2)
    const running = repo.listAll().filter((r) => r.status === 'running')
    expect(running.map((r) => r.sourceId).sort()).toEqual(['a', 'b'])
    const queued = repo.listAll().filter((r) => r.status === 'queued')
    expect(queued.map((r) => r.sourceId)).toEqual(['c'])
  })

  it('promotes the next queued row when a running slot finishes', async () => {
    manager.enqueue('fab', 'a', 'A')
    manager.enqueue('fab', 'b', 'B')
    manager.enqueue('fab', 'c', 'C')
    await flush()

    pending.get('a')!.resolve()
    await flush()

    expect(runFn).toHaveBeenCalledTimes(3)
    expect(repo.findById(repo.listAll().find((r) => r.sourceId === 'a')!.id)?.status).toBe('done')
    const running = repo.listAll().filter((r) => r.status === 'running')
    expect(running.map((r) => r.sourceId).sort()).toEqual(['b', 'c'])
  })

  it('cancelling one running slot does not affect the others', async () => {
    manager.enqueue('fab', 'a', 'A')
    const rowB = manager.enqueue('fab', 'b', 'B')
    await flush()
    expect(runFn).toHaveBeenCalledTimes(2)

    expect(manager.cancel(rowB.id)).toBe(true)
    // The runner's promise rejecting with DownloadCancelledError is how
    // production signals cancellation; the mock just rejects with a generic
    // Error and the manager records it as 'failed'. Either way the *other*
    // slot must stay running.
    pending.get('b')!.reject(new Error('aborted'))
    await flush()

    const a = repo.listAll().find((r) => r.sourceId === 'a')!
    const b = repo.listAll().find((r) => r.sourceId === 'b')!
    expect(a.status).toBe('running')
    expect(b.status).toBe('failed')
  })

  it('raising maxConcurrentDownloads at runtime fills the new slots', async () => {
    manager.enqueue('fab', 'a', 'A')
    manager.enqueue('fab', 'b', 'B')
    manager.enqueue('fab', 'c', 'C')
    manager.enqueue('fab', 'd', 'D')
    await flush()
    expect(runFn).toHaveBeenCalledTimes(2)

    settings.saveAll({ maxConcurrentDownloads: 4 })
    manager.onSettingsChanged()
    await flush()

    expect(runFn).toHaveBeenCalledTimes(4)
    const running = repo.listAll().filter((r) => r.status === 'running')
    expect(running).toHaveLength(4)
  })

  it('lowering maxConcurrentDownloads does not abort already-running slots', async () => {
    manager.enqueue('fab', 'a', 'A')
    manager.enqueue('fab', 'b', 'B')
    await flush()
    expect(runFn).toHaveBeenCalledTimes(2)

    settings.saveAll({ maxConcurrentDownloads: 1 })
    manager.onSettingsChanged()
    await flush()

    // Both still running — the lower bound only gates future starts.
    const running = repo.listAll().filter((r) => r.status === 'running')
    expect(running).toHaveLength(2)
  })

  it('stop() aborts every in-flight slot and refuses new pumps', async () => {
    manager.enqueue('fab', 'a', 'A')
    manager.enqueue('fab', 'b', 'B')
    manager.enqueue('fab', 'c', 'C')
    await flush()

    manager.stop()
    pending.get('a')!.reject(new Error('aborted'))
    pending.get('b')!.reject(new Error('aborted'))
    await flush()

    // 'c' must remain queued — stop() blocks the post-finish re-pump.
    const c = repo.listAll().find((r) => r.sourceId === 'c')!
    expect(c.status).toBe('queued')
    expect(runFn).toHaveBeenCalledTimes(2)
  })

  it('marks the row failed when no vault path is configured', async () => {
    settings.saveAll({ vaultPaths: [] })
    const row = manager.enqueue('fab', 'a', 'A')
    await flush()

    const stored = repo.findById(row.id)!
    expect(stored.status).toBe('failed')
    expect(stored.error).toMatch(/No vault path/)
    expect(runFn).not.toHaveBeenCalled()
  })
})

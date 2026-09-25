import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applySchema } from './db/schema'
import { DownloadsRepo } from './db/downloads-repo'
import { AssetsRepo } from './db/assets-repo'
import { KvStore } from './db/kv'
import { SettingsStore } from './settings'
import { readSidecar } from './vault-sidecar'

// `registerVaultIpc` calls `ipcMain.handle` / `shell` at module scope via the
// `electron` import, which doesn't exist outside a real Electron process.
// Capture each handler into a map keyed by channel so the test can invoke
// `vault:list` directly without spinning up Electron.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => `/tmp/electron-${key}`
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  shell: { openPath: vi.fn() }
}))

// Import after the mock so the module picks up the stubbed `electron`.
import { registerVaultIpc } from './vault-ipc'

let db: Database.Database
let settings: SettingsStore
let downloadsRepo: DownloadsRepo
let assetsRepo: AssetsRepo
let vaultDir: string

async function listVault(): Promise<import('./vault-ipc').VaultListResult> {
  const handler = handlers.get('vault:list')!
  return handler() as Promise<import('./vault-ipc').VaultListResult>
}

async function makeAssetDir(name: string): Promise<string> {
  const assetDir = path.join(vaultDir, name)
  await fsp.mkdir(path.join(assetDir, 'data', 'Content'), { recursive: true })
  await fsp.writeFile(path.join(assetDir, 'data', 'Content', 'dummy.uasset'), 'x')
  return assetDir
}

const UASSET_MAGIC = 0x9e2a83c1

/** Synthetic UE5 `.uasset` header (ue5=1012 -> engine version "5.4"). */
function buildUasset5_4Header(): Buffer {
  const buf = Buffer.alloc(20)
  buf.writeUInt32LE(UASSET_MAGIC, 0)
  buf.writeInt32LE(-8, 4)
  buf.writeInt32LE(0, 8)
  buf.writeInt32LE(522, 12)
  buf.writeInt32LE(1012, 16)
  return buf
}

beforeEach(async () => {
  handlers.clear()
  vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rehoarder-vault-ipc-'))

  db = new Database(':memory:')
  applySchema(db)
  applySchema(db)
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, display_name, created_at, last_used_at)
       VALUES (?, ?, ?, ?)`
  ).run('test-account', 'Test', Date.now(), Date.now())

  const kv = new KvStore(db)
  settings = new SettingsStore(kv)
  settings.saveAll({ vaultPaths: [vaultDir], maxConcurrentDownloads: 2 })

  downloadsRepo = new DownloadsRepo(db, () => 'test-account')
  assetsRepo = new AssetsRepo(db, () => 'test-account')

  registerVaultIpc(settings, downloadsRepo, assetsRepo)
})

afterEach(async () => {
  db.close()
  await fsp.rm(vaultDir, { recursive: true, force: true })
})

describe('vault:list metadata resolution order', () => {
  it('resolves metadata from the sidecar when present, without a DB row', async () => {
    const assetDir = await makeAssetDir('SidecarOnly')
    await fsp.writeFile(
      path.join(assetDir, '.rehoarder.json'),
      JSON.stringify({
        version: 1,
        type: 'vault-asset',
        source: 'fab',
        sourceId: 'sidecar-id',
        engineVersion: '5.7',
        title: 'Sidecar Title',
        kind: 'asset',
        fabDistributionMethod: null,
        downloadedAt: Date.now()
      })
    )
    // No downloads row and no assets row for 'sidecar-id' — a DB join alone
    // would leave friendlyName/source/sourceId all null.

    const result = await listVault()

    expect(result.ok).toBe(true)
    const entry = result.entries!.find((e) => e.name === 'SidecarOnly')!
    expect(entry.friendlyName).toBe('Sidecar Title')
    expect(entry.source).toBe('fab')
    expect(entry.sourceId).toBe('sidecar-id')
    expect(entry.engineVersion).toBe('5.7')
  })

  it('falls back to the DB join and backfills a sidecar when none exists', async () => {
    const assetDir = await makeAssetDir('DbJoinOnly')
    downloadsRepo.insert({
      id: 'dl-1',
      source: 'fab',
      sourceId: 'db-id',
      title: 'DB Title',
      status: 'done',
      bytesDone: 100,
      bytesTotal: 100,
      filesDone: 1,
      filesTotal: 1,
      engineVersion: '5.6',
      installTargetPath: null,
      createdAt: Date.now()
    })
    downloadsRepo.setStatus('dl-1', 'done', { destDir: assetDir })

    const result = await listVault()

    expect(result.ok).toBe(true)
    const entry = result.entries!.find((e) => e.name === 'DbJoinOnly')!
    expect(entry.friendlyName).toBe('DB Title')
    expect(entry.source).toBe('fab')
    expect(entry.sourceId).toBe('db-id')
    expect(entry.engineVersion).toBe('5.6')

    // Backfill: a sidecar should now exist so the next scan hits tier 1.
    // The backfill is fire-and-forget: poll briefly for it.
    let sidecar = await readSidecar(assetDir)
    for (let i = 0; i < 50 && !sidecar; i++) {
      await new Promise((r) => setTimeout(r, 10))
      sidecar = await readSidecar(assetDir)
    }
    expect(sidecar).not.toBeNull()
    expect(sidecar!.source).toBe('fab')
    expect(sidecar!.sourceId).toBe('db-id')
    expect(sidecar!.title).toBe('DB Title')
  })

  it('prefers the on-disk kind over a stale sidecar kind when disk is conclusive', async () => {
    // The entry's `data/` on disk is a project (.uproject present), so
    // `listLocalVault`'s `detectKind` resolves `e.kind` to 'project' before
    // the sidecar is even consulted. A sidecar wrongly claiming 'asset'
    // (e.g. written before the payload was replaced) must not override it —
    // structural on-disk detection is the source of truth.
    const assetDir = path.join(vaultDir, 'DiskWinsOverSidecar')
    await fsp.mkdir(path.join(assetDir, 'data'), { recursive: true })
    await fsp.writeFile(path.join(assetDir, 'data', 'MyProject.uproject'), '{}')
    await fsp.writeFile(
      path.join(assetDir, '.rehoarder.json'),
      JSON.stringify({
        version: 1,
        type: 'vault-asset',
        source: 'fab',
        sourceId: 'stale-id',
        engineVersion: '5.7',
        title: 'Stale Title',
        kind: 'asset',
        fabDistributionMethod: null,
        downloadedAt: Date.now()
      })
    )

    const result = await listVault()

    expect(result.ok).toBe(true)
    const entry = result.entries!.find((e) => e.name === 'DiskWinsOverSidecar')!
    expect(entry.kind).toBe('project')
    // Non-kind metadata still comes from the sidecar.
    expect(entry.friendlyName).toBe('Stale Title')
    expect(entry.source).toBe('fab')
  })

  it('uses the sidecar kind when the on-disk kind is inconclusive (unknown)', async () => {
    // `data/` exists but has neither .uproject, Engine/, nor Content/ at its
    // top level, so `detectKind` resolves to 'unknown' — a non-conclusive
    // disk read. In that case the sidecar's kind is trusted.
    const assetDir = path.join(vaultDir, 'SidecarWinsWhenDiskUnknown')
    await fsp.mkdir(path.join(assetDir, 'data'), { recursive: true })
    await fsp.writeFile(path.join(assetDir, 'data', 'readme.txt'), 'hi')
    await fsp.writeFile(
      path.join(assetDir, '.rehoarder.json'),
      JSON.stringify({
        version: 1,
        type: 'vault-asset',
        source: 'fab',
        sourceId: 'plugin-id',
        engineVersion: '5.7',
        title: 'Plugin Title',
        kind: 'plugin',
        fabDistributionMethod: null,
        downloadedAt: Date.now()
      })
    )

    const result = await listVault()

    expect(result.ok).toBe(true)
    const entry = result.entries!.find((e) => e.name === 'SidecarWinsWhenDiskUnknown')!
    expect(entry.kind).toBe('plugin')
  })

  it('leaves metadata null and reports kind only when neither sidecar nor DB row exist', async () => {
    await makeAssetDir('OrphanOnly')

    const result = await listVault()

    expect(result.ok).toBe(true)
    const entry = result.entries!.find((e) => e.name === 'OrphanOnly')!
    expect(entry.friendlyName).toBeNull()
    expect(entry.source).toBeNull()
    expect(entry.sourceId).toBeNull()
    expect(entry.engineVersion).toBeNull()
    expect(entry.kind).toBe('asset')
  })

  it('infers engineVersion for an orphan asset (no DB row, no sidecar) and backfills a sidecar', async () => {
    const assetDir = path.join(vaultDir, 'OrphanWithContent')
    await fsp.mkdir(path.join(assetDir, 'data', 'Content'), { recursive: true })
    await fsp.writeFile(
      path.join(assetDir, 'data', 'Content', 'real.uasset'),
      buildUasset5_4Header()
    )
    // No downloads row and no sidecar — this is a true orphan.

    const result = await listVault()

    expect(result.ok).toBe(true)
    const entry = result.entries!.find((e) => e.name === 'OrphanWithContent')!
    expect(entry.kind).toBe('asset')
    expect(entry.engineVersion).toBe('5.4')

    const sidecar = await readSidecar(assetDir)
    expect(sidecar).not.toBeNull()
    expect(sidecar!.engineVersion).toBe('5.4')
    expect(sidecar!.source).toBeNull()
    expect(sidecar!.sourceId).toBeNull()
  })

  it('exposes buildVersion from the DB join and writes it into the backfilled sidecar', async () => {
    const assetDir = await makeAssetDir('WithBuild')
    downloadsRepo.insert({
      id: 'dl-b',
      source: 'fab',
      sourceId: 'build-id',
      title: 'Build Title',
      status: 'done',
      bytesDone: 1,
      bytesTotal: 1,
      filesDone: 1,
      filesTotal: 1,
      engineVersion: '5.7',
      installTargetPath: null,
      createdAt: Date.now()
    })
    downloadsRepo.setStatus('dl-b', 'done', {
      destDir: assetDir,
      buildVersion: '5.7.0-48201490+++UE5+Dev-Marketplace-Windows'
    })

    const result = await listVault()
    const entry = result.entries!.find((e) => e.name === 'WithBuild')!
    expect(entry.buildVersion).toBe('5.7.0-48201490+++UE5+Dev-Marketplace-Windows')
    // The tier-2 sidecar backfill is fire-and-forget: poll briefly for it.
    let sidecar = await readSidecar(assetDir)
    for (let i = 0; i < 50 && !sidecar; i++) {
      await new Promise((r) => setTimeout(r, 10))
      sidecar = await readSidecar(assetDir)
    }
    expect(sidecar?.buildVersion).toBe('5.7.0-48201490+++UE5+Dev-Marketplace-Windows')
  })

  it('falls back to the DB buildVersion when an existing sidecar predates the field', async () => {
    const assetDir = await makeAssetDir('OldSidecar')
    await fsp.writeFile(
      path.join(assetDir, '.rehoarder.json'),
      JSON.stringify({
        version: 1,
        type: 'vault-asset',
        source: 'fab',
        sourceId: 'old-id',
        engineVersion: '5.5',
        title: 'Old Sidecar',
        kind: 'asset',
        fabDistributionMethod: null,
        downloadedAt: 1
      })
    )
    downloadsRepo.insert({
      id: 'dl-o',
      source: 'fab',
      sourceId: 'old-id',
      title: 'Old Sidecar',
      status: 'done',
      bytesDone: 1,
      bytesTotal: 1,
      filesDone: 1,
      filesTotal: 1,
      engineVersion: '5.5',
      installTargetPath: null,
      createdAt: Date.now()
    })
    downloadsRepo.setStatus('dl-o', 'done', { destDir: assetDir, buildVersion: '5.5.0-38995378+++x' })

    const result = await listVault()
    const entry = result.entries!.find((e) => e.name === 'OldSidecar')!
    expect(entry.buildVersion).toBe('5.5.0-38995378+++x')
  })

  it('leaves buildVersion null for an orphan folder', async () => {
    await makeAssetDir('Orphan')
    const result = await listVault()
    expect(result.entries!.find((e) => e.name === 'Orphan')!.buildVersion).toBeNull()
  })
})

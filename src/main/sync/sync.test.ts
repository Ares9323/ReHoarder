import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { AssetsRepo } from '../db/assets-repo'
import { Sync, type SyncProgress, type SyncResult } from './sync'

let db: Database.Database
let repo: AssetsRepo
let sync: Sync
let vaultClient: {
  listOwnedAssets: ReturnType<typeof vi.fn>
  fetchCatalogMetadata: ReturnType<typeof vi.fn>
}
let fabSessionClient: { establishSession: ReturnType<typeof vi.fn> }
let fabClient: {
  listLibrary: ReturnType<typeof vi.fn>
  listOtherLibrary: ReturnType<typeof vi.fn>
}

function makeEpicSessionFactory(ueReady = true) {
  return {
    create: vi.fn().mockResolvedValue({
      jar: {},
      ue4SessionReady: ueReady,
      getCookieHeader: vi.fn().mockReturnValue('')
    })
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  applySchema(db)
  repo = new AssetsRepo(db)

  vaultClient = {
    listOwnedAssets: vi.fn(),
    fetchCatalogMetadata: vi.fn()
  }
  fabSessionClient = { establishSession: vi.fn() }
  fabClient = {
    listLibrary: vi.fn(),
    listOtherLibrary: vi.fn().mockImplementation(() => yieldPages([]))
  }

  sync = new Sync(
    repo,
    vaultClient as never,
    makeEpicSessionFactory() as never,
    fabSessionClient as never,
    fabClient as never
  )
})

async function* yieldPages<T>(pages: T[]): AsyncGenerator<T> {
  for (const p of pages) yield p
}

describe('Sync.syncAll', () => {
  it('fetches vault list + bulk metadata, fetches fab session + library pages, persists rows', async () => {
    vaultClient.listOwnedAssets.mockResolvedValue([
      { namespace: 'ue', catalogItemId: 'cat-1', appName: 'A1', labelName: 'Live' },
      { namespace: 'ue', catalogItemId: 'cat-2', appName: 'A2', labelName: 'Live' }
    ])
    vaultClient.fetchCatalogMetadata.mockResolvedValue({
      'cat-1': { id: 'cat-1', title: 'Vault One' },
      'cat-2': { id: 'cat-2', title: 'Vault Two' }
    })
    fabSessionClient.establishSession.mockResolvedValue({
      cookieHeader: 'csrftoken=x; sessionid=y'
    })
    fabClient.listLibrary.mockReturnValue(
      yieldPages([{ results: [{ assetId: 'f-1', title: 'Fab One' }], cursors: { next: null } }])
    )

    const progress: SyncProgress[] = []
    const result = await sync.syncAll('bearer', 'acct-1', (p) => progress.push(p))

    expect(result).toMatchObject<SyncResult>({
      vault: { fetched: 2, persisted: 2, error: null },
      fab: { fetched: 1, persisted: 1, error: null }
    })
    expect(repo.countAll()).toBe(3)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toMatchObject({ phase: 'done', total: 3 })
  })

  it('records vault error in result but still attempts fab', async () => {
    vaultClient.listOwnedAssets.mockRejectedValue(new Error('vault down'))
    fabSessionClient.establishSession.mockResolvedValue({ cookieHeader: 'c' })
    fabClient.listLibrary.mockReturnValue(
      yieldPages([{ results: [{ assetId: 'f-1', title: 'Fab One' }], cursors: { next: null } }])
    )

    const result = await sync.syncAll('bearer', 'acct-1', () => {})

    expect(result.vault.error).toMatch(/vault down/)
    expect(result.vault.persisted).toBe(0)
    expect(result.fab.persisted).toBe(1)
  })

  it('records fab error in result but still keeps vault data', async () => {
    vaultClient.listOwnedAssets.mockResolvedValue([
      { namespace: 'ue', catalogItemId: 'cat-1', appName: 'A1', labelName: 'Live' }
    ])
    vaultClient.fetchCatalogMetadata.mockResolvedValue({
      'cat-1': { id: 'cat-1', title: 'Vault One' }
    })
    fabSessionClient.establishSession.mockRejectedValue(new Error('fab login failed'))

    const result = await sync.syncAll('bearer', 'acct-1', () => {})

    expect(result.vault.persisted).toBe(1)
    expect(result.fab.error).toMatch(/fab login failed/)
    expect(repo.countAll()).toBe(1)
  })

  it('early-stops Fab UE pagination when a page contains only already-known IDs', async () => {
    // Seed the DB with one Fab asset already synced previously.
    repo.upsert({
      source: 'fab',
      sourceId: 'old-1',
      title: 'Already there',
      description: null,
      imageUrl: null,
      productUrl: null,
      ownedAt: null,
      hidden: false,
      bookmarked: false,
      subSource: 'fab-ue',
      raw: '{}',
      syncedAt: 0
    })

    vaultClient.listOwnedAssets.mockResolvedValue([])
    vaultClient.fetchCatalogMetadata.mockResolvedValue({})
    fabSessionClient.establishSession.mockResolvedValue({ cookieHeader: 'c' })

    // Page 1: 1 new + 1 old   → mixed → keep paginating
    // Page 2: 1 old           → all known → STOP (don't request page 3)
    // Page 3: would be 1 new  → MUST NOT be reached
    const pages = [
      {
        results: [
          { assetId: 'new-1', title: 'New 1' },
          { assetId: 'old-1', title: 'Already there' }
        ],
        cursors: { next: 'c-2' }
      },
      {
        results: [{ assetId: 'old-1', title: 'Already there' }],
        cursors: { next: 'c-3' }
      },
      {
        results: [{ assetId: 'new-2', title: 'Should NOT be reached' }],
        cursors: { next: null }
      }
    ]
    fabClient.listLibrary.mockImplementation(() => yieldPages(pages))

    await sync.syncAll('bearer', 'acct-1', () => {})

    expect(repo.findById('fab', 'new-1')?.title).toBe('New 1')
    expect(repo.findById('fab', 'new-2')).toBeNull() // page 3 never fetched
  })

  it('full-syncs without early-stop when no Fab assets are in the DB yet', async () => {
    vaultClient.listOwnedAssets.mockResolvedValue([])
    vaultClient.fetchCatalogMetadata.mockResolvedValue({})
    fabSessionClient.establishSession.mockResolvedValue({ cookieHeader: 'c' })

    // Empty first page would normally early-stop (pageNew===0), but with an
    // empty DB the sync runs in full mode and processes every page.
    const pages = [
      { results: [], cursors: { next: 'c-2' } },
      {
        results: [{ assetId: 'late-1', title: 'Late discovery' }],
        cursors: { next: null }
      }
    ]
    fabClient.listLibrary.mockImplementation(() => yieldPages(pages))

    await sync.syncAll('bearer', 'acct-1', () => {})

    expect(repo.findById('fab', 'late-1')?.title).toBe('Late discovery')
  })

  it('persists Fab Other listings and skips unreal-engine duplicates', async () => {
    vaultClient.listOwnedAssets.mockResolvedValue([])
    vaultClient.fetchCatalogMetadata.mockResolvedValue({})
    fabSessionClient.establishSession.mockResolvedValue({ cookieHeader: 'c' })
    fabClient.listLibrary.mockReturnValue(yieldPages([{ results: [], cursors: { next: null } }]))
    fabClient.listOtherLibrary.mockImplementation(() =>
      yieldPages([
        {
          results: [
            // Non-UE listing → persisted
            {
              listing: {
                uid: 'other-1',
                title: 'Blender Pack',
                assetFormats: [{ assetFormatType: { code: 'blender', name: 'Blender' } }]
              }
            },
            // UE-only listing → skipped as already in /ue/library
            {
              listing: {
                uid: 'other-2',
                title: 'UE Already Covered',
                assetFormats: [
                  { assetFormatType: { code: 'unreal-engine', name: 'Unreal Engine' } }
                ]
              }
            },
            // Missing uid → skipped
            { listing: { uid: '', title: 'Broken' } }
          ],
          next: null
        }
      ])
    )

    const result = await sync.syncAll('bearer', 'acct-1', () => {})

    expect(result.fab.persisted).toBe(1)
    expect(repo.findById('fab', 'other-1')?.title).toBe('Blender Pack')
    expect(repo.findById('fab', 'other-2')).toBeNull()
  })

  it('writes sync_state rows for each source', async () => {
    vaultClient.listOwnedAssets.mockResolvedValue([])
    vaultClient.fetchCatalogMetadata.mockResolvedValue({})
    fabSessionClient.establishSession.mockResolvedValue({ cookieHeader: 'c' })
    fabClient.listLibrary.mockReturnValue(yieldPages([{ results: [], cursors: { next: null } }]))

    await sync.syncAll('bearer', 'acct-1', () => {})

    const rows = db.prepare('SELECT source, last_sync_status FROM sync_state').all() as Array<{
      source: string
      last_sync_status: string
    }>
    const map = Object.fromEntries(rows.map((r) => [r.source, r.last_sync_status]))
    expect(map).toEqual({ vault: 'ok', fab: 'ok' })
  })
})

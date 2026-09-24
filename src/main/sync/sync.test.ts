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
let fabWebSession: { getJson: ReturnType<typeof vi.fn> }

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
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, display_name, created_at, last_used_at)
       VALUES (?, ?, ?, ?)`
  ).run('test-account', 'Test', Date.now(), Date.now())
  repo = new AssetsRepo(db, () => 'test-account')

  vaultClient = {
    listOwnedAssets: vi.fn(),
    fetchCatalogMetadata: vi.fn()
  }
  fabSessionClient = { establishSession: vi.fn() }
  fabClient = {
    listLibrary: vi.fn(),
    listOtherLibrary: vi.fn().mockImplementation(() => yieldPages([]))
  }
  fabWebSession = {
    getJson: vi.fn().mockResolvedValue({ status: 200, body: { results: [], next: null } })
  }

  sync = new Sync(
    repo,
    vaultClient as never,
    makeEpicSessionFactory() as never,
    fabSessionClient as never,
    fabClient as never,
    fabWebSession as never
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

  it('paginates the entire Fab UE library — no incremental early-stop', async () => {
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
      listingType: null,
      seller: null,
      raw: '{}',
      syncedAt: 0,
      lastPreciseAt: null
    })

    vaultClient.listOwnedAssets.mockResolvedValue([])
    vaultClient.fetchCatalogMetadata.mockResolvedValue({})
    fabSessionClient.establishSession.mockResolvedValue({ cookieHeader: 'c' })

    // The previous version of this test asserted that page 3 was never
    // reached when page 2 was "all known". That early-stop was dropped:
    // Fab UE library is sorted by listing createdAt, not acquisition time,
    // so freshly-claimed freebies (old listings) sit deep in the cursor
    // and would be missed. The sync now walks every page.
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
        results: [{ assetId: 'new-2', title: 'New 2 — late' }],
        cursors: { next: null }
      }
    ]
    fabClient.listLibrary.mockImplementation(() => yieldPages(pages))

    await sync.syncAll('bearer', 'acct-1', () => {})

    expect(repo.findById('fab', 'new-1')?.title).toBe('New 1')
    // The previously-unreachable page now lands in the DB too.
    expect(repo.findById('fab', 'new-2')?.title).toBe('New 2 — late')
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

  it('pages UE entitlements through the Fab web session and logs the count', async () => {
    vaultClient.listOwnedAssets.mockResolvedValue([])
    vaultClient.fetchCatalogMetadata.mockResolvedValue({})
    fabSessionClient.establishSession.mockResolvedValue({ cookieHeader: 'fab_csrftoken=t' })
    fabClient.listLibrary.mockReturnValue(yieldPages([{ results: [], cursors: { next: null } }]))
    fabWebSession.getJson
      .mockResolvedValueOnce({
        status: 200,
        body: {
          results: [
            { listing: { uid: 'L-1' }, createdAt: '2026-01-01T00:00:00+00:00' },
            { listing: {} }
          ],
          next: 'https://www.fab.com/i/library/search?cursor=p2&source=acquired'
        }
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { results: [{ listing: { uid: 'L-2' } }], next: null }
      })

    const log: string[] = []
    const result = await sync.syncAll('bearer', 'acct-1', () => {}, (l) => log.push(l))

    const paths = fabWebSession.getJson.mock.calls.map((c) => c[0] as string)
    expect(paths).toHaveLength(2)
    const first = new URL(paths[0], 'https://www.fab.com')
    expect(first.pathname).toBe('/i/library/search')
    expect(first.searchParams.get('source')).toBe('acquired')
    expect(first.searchParams.getAll('asset_formats')).toEqual(['unreal-engine'])
    expect(first.searchParams.get('sort_by')).toBe('-createdAt')
    expect(paths[1]).toBe('/i/library/search?cursor=p2&source=acquired')
    expect(result.fab.error).toBeNull()
    expect(log).toContain('Fab: entitlements page 1 received (+2)')
    expect(log).toContain('Fab: entitlements collected for 2 listings')
  })

  it('skips entitlements with a sign-in hint when fab.com is logged out', async () => {
    vaultClient.listOwnedAssets.mockResolvedValue([])
    vaultClient.fetchCatalogMetadata.mockResolvedValue({})
    fabSessionClient.establishSession.mockResolvedValue({ cookieHeader: 'c' })
    fabClient.listLibrary.mockReturnValue(
      yieldPages([{ results: [{ assetId: 'f-1', title: 'Fab One' }], cursors: { next: null } }])
    )
    fabWebSession.getJson.mockResolvedValue({ status: 401, body: null })

    const log: string[] = []
    const result = await sync.syncAll('bearer', 'acct-1', () => {}, (l) => log.push(l))

    expect(result.fab.error).toBeNull()
    expect(result.fab.persisted).toBe(1)
    expect(log).toContain(
      'Fab: not signed in to fab.com, dates and licenses skipped. Use "Sign in to Fab" to enable them.'
    )
  })

  it('treats an unreachable web session as a warning, not a Fab sync error', async () => {
    vaultClient.listOwnedAssets.mockResolvedValue([])
    vaultClient.fetchCatalogMetadata.mockResolvedValue({})
    fabSessionClient.establishSession.mockResolvedValue({ cookieHeader: 'c' })
    fabClient.listLibrary.mockReturnValue(
      yieldPages([{ results: [{ assetId: 'f-1', title: 'Fab One' }], cursors: { next: null } }])
    )
    fabWebSession.getJson.mockResolvedValue({ status: -1, body: null })

    const log: string[] = []
    const result = await sync.syncAll('bearer', 'acct-1', () => {}, (l) => log.push(l))

    expect(result.fab.error).toBeNull()
    expect(result.fab.persisted).toBe(1)
    expect(log.some((l) => l.includes('WARNING entitlements unavailable') && l.includes('-1'))).toBe(
      true
    )
  })
})

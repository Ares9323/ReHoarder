import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from './schema'
import { AssetsRepo, type AssetRow } from './assets-repo'

let db: Database.Database
let repo: AssetsRepo
const TEST_ACCOUNT_ID = 'test-account'

beforeEach(() => {
  db = new Database(':memory:')
  applySchema(db)
  // Seed the accounts row so the scoped repo has something to bind to.
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, display_name, created_at, last_used_at)
       VALUES (?, ?, ?, ?)`
  ).run(TEST_ACCOUNT_ID, 'Test', Date.now(), Date.now())
  repo = new AssetsRepo(db, () => TEST_ACCOUNT_ID)
})

const sampleAsset = (over: Partial<AssetRow> = {}): AssetRow => ({
  source: 'vault',
  sourceId: 'cat-1',
  title: 'Test Asset',
  description: 'A nice asset',
  imageUrl: 'https://img.example/1.png',
  productUrl: 'https://www.unrealengine.com/marketplace/en-US/product/test-asset',
  ownedAt: 1_700_000_000_000,
  hidden: false,
  bookmarked: false,
  subSource: null,
  listingType: null,
  seller: null,
  raw: '{}',
  syncedAt: 1_700_000_000_000,
  lastPreciseAt: null,
  ...over
})

describe('AssetsRepo.upsert', () => {
  it('inserts a new asset', () => {
    repo.upsert(sampleAsset())
    expect(repo.findById('vault', 'cat-1')).toMatchObject({
      title: 'Test Asset',
      source: 'vault',
      sourceId: 'cat-1'
    })
  })

  it('updates an existing asset (same source+source_id)', () => {
    repo.upsert(sampleAsset({ title: 'Old Title' }))
    repo.upsert(sampleAsset({ title: 'New Title' }))
    expect(repo.findById('vault', 'cat-1')?.title).toBe('New Title')
    expect(repo.countAll()).toBe(1)
  })

  it('preserves hidden flag across an upsert from sync (does not flip back to 0)', () => {
    repo.upsert(sampleAsset({ hidden: false }))
    repo.setHidden('vault', 'cat-1', true)
    repo.upsert(sampleAsset({ hidden: false, title: 'Re-synced' }))
    expect(repo.findById('vault', 'cat-1')?.hidden).toBe(true)
    expect(repo.findById('vault', 'cat-1')?.title).toBe('Re-synced')
  })
})

describe('AssetsRepo.list (filters)', () => {
  beforeEach(() => {
    // `list()` excludes `source = 'vault'` from the default result set (the
    // Epic CDN scope for those is gone), so the fixture deliberately uses
    // `legacy` / `fab` sources to keep the default-listing assertions
    // meaningful. A separate test below covers the vault-exclusion contract.
    repo.upsert(sampleAsset({ sourceId: 'a', title: 'Alpha', source: 'legacy' }))
    repo.upsert(sampleAsset({ sourceId: 'b', title: 'Beta', source: 'fab' }))
    repo.upsert(sampleAsset({ sourceId: 'c', title: 'Gamma', source: 'legacy' }))
    repo.setHidden('legacy', 'a', true)
  })

  it('returns all non-hidden assets by default', () => {
    const result = repo.list({})
    expect(result.map((r) => r.sourceId).sort()).toEqual(['b', 'c'])
  })

  it('returns hidden assets when includeHidden is true', () => {
    const result = repo.list({ includeHidden: true })
    expect(result.map((r) => r.sourceId).sort()).toEqual(['a', 'b', 'c'])
  })

  it('filters by source', () => {
    const result = repo.list({ source: 'fab' })
    expect(result.map((r) => r.sourceId)).toEqual(['b'])
  })

  it('filters by case-insensitive search in title and description', () => {
    const result = repo.list({ search: 'beta' })
    expect(result.map((r) => r.sourceId)).toEqual(['b'])
  })

  it('matches multi-token search across title + seller (any field per token)', () => {
    repo.upsert(
      sampleAsset({
        sourceId: 'cry-cave',
        source: 'fab',
        title: 'Crystal Cave',
        seller: 'Laya Design'
      })
    )
    repo.upsert(
      sampleAsset({
        sourceId: 'other-laya',
        source: 'fab',
        title: 'Forest Pack',
        seller: 'Laya Design'
      })
    )
    // "laya cry" → token "laya" hits seller, token "cry" hits title;
    // only the asset where BOTH tokens match anywhere should come back.
    const result = repo.list({ search: 'laya cry' })
    expect(result.map((r) => r.sourceId)).toEqual(['cry-cave'])
  })

  it('escapes LIKE wildcards in search input', () => {
    repo.upsert(sampleAsset({ sourceId: 'pct', source: 'fab', title: '100% Discount' }))
    repo.upsert(sampleAsset({ sourceId: 'plain', source: 'fab', title: 'Hundred Discount' }))
    // The literal "%" must not act as a wildcard — only "100% Discount" should match.
    const result = repo.list({ search: '100%' })
    expect(result.map((r) => r.sourceId)).toEqual(['pct'])
  })

  it('orders by title ASC by default', () => {
    const result = repo.list({})
    expect(result.map((r) => r.title)).toEqual(['Beta', 'Gamma'])
  })

  it('hides vault assets by default but surfaces them when source=vault is requested', () => {
    repo.upsert(sampleAsset({ sourceId: 'v1', title: 'Vault Item', source: 'vault' }))
    const defaultRows = repo.list({})
    expect(defaultRows.map((r) => r.sourceId)).not.toContain('v1')
    const vaultRows = repo.list({ source: 'vault' })
    expect(vaultRows.map((r) => r.sourceId)).toEqual(['v1'])
  })

  it('keeps fab-ue assets in the default listing', () => {
    repo.upsert(
      sampleAsset({ sourceId: 'u1', title: 'UE Pack', source: 'fab', subSource: 'fab-ue' })
    )
    expect(repo.list({}).map((r) => r.sourceId)).toContain('u1')
  })

  /** Regression guard: vault and legacy rows (sub_source NULL) must stay in the default listing. */
  it('does not drop rows whose sub_source is NULL', () => {
    // 'a' (hidden) / 'c' are legacy with subSource null; 'b' is fab with null too.
    expect(repo.list({}).map((r) => r.sourceId).sort()).toEqual(['b', 'c'])
    repo.upsert(sampleAsset({ sourceId: 'v1', source: 'vault', subSource: null }))
    expect(repo.list({ source: 'vault' }).map((r) => r.sourceId)).toEqual(['v1'])
  })
})

describe('AssetsRepo.setHidden', () => {
  beforeEach(() => {
    repo.upsert(sampleAsset({ sourceId: 'x' }))
  })

  it('hides an asset', () => {
    repo.setHidden('vault', 'x', true)
    expect(repo.findById('vault', 'x')?.hidden).toBe(true)
  })

  it('unhides an asset', () => {
    repo.setHidden('vault', 'x', true)
    repo.setHidden('vault', 'x', false)
    expect(repo.findById('vault', 'x')?.hidden).toBe(false)
  })

  it('is a no-op when the asset does not exist (no throw)', () => {
    expect(() => repo.setHidden('vault', 'does-not-exist', true)).not.toThrow()
  })
})

describe('AssetsRepo.countAll / countBySource', () => {
  it('counts all assets including hidden', () => {
    repo.upsert(sampleAsset({ sourceId: 'a' }))
    repo.upsert(sampleAsset({ sourceId: 'b', source: 'fab' }))
    repo.setHidden('vault', 'a', true)
    expect(repo.countAll()).toBe(2)
  })

  it('returns counts grouped by source', () => {
    repo.upsert(sampleAsset({ sourceId: 'a' }))
    repo.upsert(sampleAsset({ sourceId: 'b' }))
    repo.upsert(sampleAsset({ sourceId: 'c', source: 'fab' }))
    expect(repo.countBySource()).toEqual({ vault: 2, fab: 1 })
  })
})

describe('AssetsRepo.knownSourceIds', () => {
  it('returns an empty set when the source has no rows', () => {
    expect(repo.knownSourceIds('fab').size).toBe(0)
  })

  it('returns only IDs matching the given source', () => {
    repo.upsert(sampleAsset({ sourceId: 'v-1' }))
    repo.upsert(sampleAsset({ sourceId: 'v-2' }))
    repo.upsert(sampleAsset({ sourceId: 'f-1', source: 'fab' }))
    repo.upsert(sampleAsset({ sourceId: 'f-2', source: 'fab' }))

    const fabIds = repo.knownSourceIds('fab')
    expect(fabIds.size).toBe(2)
    expect(fabIds.has('f-1')).toBe(true)
    expect(fabIds.has('f-2')).toBe(true)
    expect(fabIds.has('v-1')).toBe(false)
  })
})

describe('AssetsRepo tags', () => {
  beforeEach(() => {
    repo.upsert(sampleAsset({ sourceId: 'a' }))
  })

  it('adds a tag and reads it back', () => {
    repo.addTag('vault', 'a', 'used')
    expect(repo.getTags('vault', 'a')).toEqual(['used'])
  })

  it('adding the same tag twice is a no-op (no duplicates)', () => {
    repo.addTag('vault', 'a', 'used')
    repo.addTag('vault', 'a', 'used')
    expect(repo.getTags('vault', 'a')).toEqual(['used'])
  })

  it('removes a tag', () => {
    repo.addTag('vault', 'a', 'used')
    repo.addTag('vault', 'a', 'wishlist')
    repo.removeTag('vault', 'a', 'used')
    expect(repo.getTags('vault', 'a').sort()).toEqual(['wishlist'])
  })

  it('lists tags alphabetically', () => {
    repo.addTag('vault', 'a', 'zeta')
    repo.addTag('vault', 'a', 'alpha')
    expect(repo.getTags('vault', 'a')).toEqual(['alpha', 'zeta'])
  })

  it('cascades tag deletion when the asset is deleted', () => {
    repo.addTag('vault', 'a', 'used')
    db.prepare('DELETE FROM assets WHERE source = ? AND source_id = ?').run('vault', 'a')
    expect(repo.getTags('vault', 'a')).toEqual([])
  })

  it('returns the set of all tags in use across the library', () => {
    repo.upsert(sampleAsset({ sourceId: 'b', source: 'fab' }))
    repo.addTag('vault', 'a', 'used')
    repo.addTag('vault', 'a', 'wishlist')
    repo.addTag('fab', 'b', 'used')
    expect(repo.getAllTags().sort()).toEqual(['used', 'wishlist'])
  })
})

describe('AssetsRepo Fab entitlements', () => {
  const fabRow = (over: Partial<AssetRow> = {}): AssetRow =>
    sampleAsset({
      source: 'fab',
      subSource: 'fab-ue',
      sourceId: 'asset-1',
      ownedAt: null,
      fabListingUid: 'listing-1',
      engineVersions: ['5.4', '5.3'],
      ...over
    })

  it('stores and reads back fabListingUid and engineVersions', () => {
    repo.upsert(fabRow())
    const row = repo.findById('fab', 'asset-1')
    expect(row?.fabListingUid).toBe('listing-1')
    expect(row?.engineVersions).toEqual(['5.4', '5.3'])
    expect(row?.licenses).toEqual([])
    expect(row?.lastUpdatedAt).toBeNull()
  })

  it('applies entitlements by listing uid and reports unmatched', () => {
    repo.upsert(fabRow())
    const r = repo.applyFabEntitlements(
      new Map([
        ['listing-1', { ownedAt: 111, lastUpdatedAt: 222, licenses: ['personal'] }],
        ['listing-missing', { ownedAt: 1, lastUpdatedAt: null, licenses: [] }]
      ])
    )
    expect(r).toEqual({ matched: 1, unmatched: 1 })
    const row = repo.findById('fab', 'asset-1')
    expect(row?.ownedAt).toBe(111)
    expect(row?.lastUpdatedAt).toBe(222)
    expect(row?.licenses).toEqual(['personal'])
  })

  it('keeps entitlement data when a later library sync upserts the same row', () => {
    repo.upsert(fabRow())
    repo.applyFabEntitlements(
      new Map([['listing-1', { ownedAt: 111, lastUpdatedAt: 222, licenses: ['personal'] }]])
    )
    repo.upsert(fabRow({ title: 'Renamed', engineVersions: ['5.5'] }))
    const row = repo.findById('fab', 'asset-1')
    expect(row?.title).toBe('Renamed')
    expect(row?.engineVersions).toEqual(['5.5'])
    expect(row?.ownedAt).toBe(111)
    expect(row?.lastUpdatedAt).toBe(222)
    expect(row?.licenses).toEqual(['personal'])
  })

  it('does not null out owned_at when an entitlement has no createdAt', () => {
    repo.upsert(fabRow({ ownedAt: 50 }))
    repo.applyFabEntitlements(
      new Map([['listing-1', { ownedAt: null, lastUpdatedAt: null, licenses: [] }]])
    )
    expect(repo.findById('fab', 'asset-1')?.ownedAt).toBe(50)
  })
})

describe('AssetsRepo.list sorting and Fab filters', () => {
  function seed(): void {
    const rows: Array<Partial<AssetRow>> = [
      {
        sourceId: 'a',
        title: 'Alpha',
        seller: 'Studio A',
        fabListingUid: 'la',
        engineVersions: ['5.4', '5.3']
      },
      {
        sourceId: 'b',
        title: 'Bravo',
        seller: 'Studio B',
        fabListingUid: 'lb',
        engineVersions: ['5.10']
      },
      {
        sourceId: 'c',
        title: 'Charlie',
        seller: 'Studio A',
        fabListingUid: 'lc',
        engineVersions: ['4.27']
      },
      { sourceId: 'd', title: 'Delta', seller: null, fabListingUid: null, engineVersions: [] }
    ]
    for (const r of rows) {
      repo.upsert(sampleAsset({ source: 'fab', subSource: 'fab-ue', ownedAt: null, ...r }))
    }
    repo.applyFabEntitlements(
      new Map([
        ['la', { ownedAt: 300, lastUpdatedAt: 10, licenses: ['personal'] }],
        ['lb', { ownedAt: 100, lastUpdatedAt: 30, licenses: ['professional', 'legacy-uem'] }],
        ['lc', { ownedAt: 200, lastUpdatedAt: null, licenses: ['personal'] }]
      ])
    )
  }
  const titles = (rows: AssetRow[]): string[] => rows.map((r) => r.title)

  it('defaults to title A-Z and supports Z-A', () => {
    seed()
    expect(titles(repo.list({}))).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta'])
    expect(titles(repo.list({ sort: 'title-desc' }))).toEqual([
      'Delta',
      'Charlie',
      'Bravo',
      'Alpha'
    ])
  })

  it('sorts by acquisition date with undated rows last in both directions', () => {
    seed()
    expect(titles(repo.list({ sort: 'newest' }))).toEqual(['Alpha', 'Charlie', 'Bravo', 'Delta'])
    expect(titles(repo.list({ sort: 'oldest' }))).toEqual(['Bravo', 'Charlie', 'Alpha', 'Delta'])
  })

  it('sorts by last update with undated rows last', () => {
    seed()
    expect(titles(repo.list({ sort: 'last-updated' }))).toEqual([
      'Bravo',
      'Alpha',
      'Charlie',
      'Delta'
    ])
  })

  it('falls back to title A-Z on an unknown sort value', () => {
    seed()
    expect(titles(repo.list({ sort: 'bogus; DROP TABLE assets' as never }))).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta'
    ])
  })

  it('filters by seller, license, engine version and ownedSince, alone and combined', () => {
    seed()
    expect(titles(repo.list({ seller: 'Studio A' }))).toEqual(['Alpha', 'Charlie'])
    expect(titles(repo.list({ license: 'personal' }))).toEqual(['Alpha', 'Charlie'])
    expect(titles(repo.list({ license: 'legacy-uem' }))).toEqual(['Bravo'])
    expect(titles(repo.list({ engineVersion: '5.3' }))).toEqual(['Alpha'])
    expect(titles(repo.list({ ownedSince: 200 }))).toEqual(['Alpha', 'Charlie'])
    expect(
      titles(repo.list({ seller: 'Studio A', engineVersion: '4.27', license: 'personal' }))
    ).toEqual(['Charlie'])
  })

  it('lists sellers, licenses and engine versions for the dropdowns', () => {
    seed()
    expect(repo.availableSellers()).toEqual(['Studio A', 'Studio B'])
    expect(repo.availableLicenses()).toEqual(['legacy-uem', 'personal', 'professional'])
    expect(repo.availableEngineVersions()).toEqual(['5.10', '5.4', '5.3', '4.27'])
  })
})

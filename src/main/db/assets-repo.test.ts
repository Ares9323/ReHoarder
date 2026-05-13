import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from './schema'
import { AssetsRepo, type AssetRow } from './assets-repo'

let db: Database.Database
let repo: AssetsRepo

beforeEach(() => {
  db = new Database(':memory:')
  applySchema(db)
  repo = new AssetsRepo(db)
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
  raw: '{}',
  syncedAt: 1_700_000_000_000,
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
    repo.upsert(sampleAsset({ sourceId: 'a', title: 'Alpha', source: 'vault' }))
    repo.upsert(sampleAsset({ sourceId: 'b', title: 'Beta', source: 'fab' }))
    repo.upsert(sampleAsset({ sourceId: 'c', title: 'Gamma', source: 'vault' }))
    repo.setHidden('vault', 'a', true)
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

  it('orders by title ASC by default', () => {
    const result = repo.list({})
    expect(result.map((r) => r.title)).toEqual(['Beta', 'Gamma'])
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

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from './schema'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  applySchema(db)
})

function tableInfo(
  name: string
): Array<{ name: string; type: string; notnull: number; pk: number }> {
  return db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
    name: string
    type: string
    notnull: number
    pk: number
  }>
}

function indexList(table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name
  )
}

describe('applySchema', () => {
  it('creates an assets table with the expected columns and composite PK', () => {
    const cols = tableInfo('assets')
    const colNames = cols.map((c) => c.name)
    expect(colNames).toEqual([
      'source',
      'source_id',
      'title',
      'description',
      'image_url',
      'product_url',
      'owned_at',
      'hidden',
      'raw',
      'synced_at'
    ])
    expect(cols.find((c) => c.name === 'source')?.pk).toBe(1)
    expect(cols.find((c) => c.name === 'source_id')?.pk).toBe(2)
    expect(cols.find((c) => c.name === 'hidden')?.notnull).toBe(1)
  })

  it('creates an asset_tags table with composite PK and references assets(source, source_id)', () => {
    const cols = tableInfo('asset_tags')
    expect(cols.map((c) => c.name)).toEqual(['source', 'source_id', 'tag'])
    const fk = db.prepare(`PRAGMA foreign_key_list(asset_tags)`).all() as Array<{
      table: string
      from: string
      to: string
    }>
    expect(fk.length).toBeGreaterThan(0)
    expect(fk[0].table).toBe('assets')
  })

  it('creates a sync_state table keyed by source', () => {
    const cols = tableInfo('sync_state')
    expect(cols.map((c) => c.name)).toEqual([
      'source',
      'last_sync_at',
      'last_sync_status',
      'last_sync_error'
    ])
    expect(cols.find((c) => c.name === 'source')?.pk).toBe(1)
  })

  it('creates indexes on assets.hidden and assets.source', () => {
    const idxs = indexList('assets')
    expect(idxs).toEqual(expect.arrayContaining(['idx_assets_hidden', 'idx_assets_source']))
  })

  it('creates an index on asset_tags.tag for "find by tag" queries', () => {
    const idxs = indexList('asset_tags')
    expect(idxs).toEqual(expect.arrayContaining(['idx_asset_tags_tag']))
  })

  it('is idempotent (applying twice does not throw)', () => {
    expect(() => applySchema(db)).not.toThrow()
  })
})

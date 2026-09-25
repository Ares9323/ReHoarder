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
  it('creates an assets table with the expected columns and account-scoped PK', () => {
    const cols = tableInfo('assets')
    const colNames = cols.map((c) => c.name)
    // The column set is asserted as a SET (migrations append new columns; the
    // order in `PRAGMA table_info` depends on whether you're on a fresh DB or
    // walking through migrations, so a strict ordered check is brittle).
    expect(colNames.sort()).toEqual(
      [
        'account_id',
        'source',
        'source_id',
        'title',
        'description',
        'image_url',
        'product_url',
        'owned_at',
        'hidden',
        'bookmarked',
        'sub_source',
        'listing_type',
        'seller',
        'raw',
        'synced_at',
        'last_precise_at',
        'fab_listing_uid',
        'last_updated_at',
        'licenses',
        'engine_versions'
      ].sort()
    )
    // Composite PK is (account_id, source, source_id) — the order matters for
    // SQLite's index, so we check positions explicitly.
    expect(cols.find((c) => c.name === 'account_id')?.pk).toBe(1)
    expect(cols.find((c) => c.name === 'source')?.pk).toBe(2)
    expect(cols.find((c) => c.name === 'source_id')?.pk).toBe(3)
    expect(cols.find((c) => c.name === 'hidden')?.notnull).toBe(1)
  })

  it('creates an asset_tags table with composite PK and references assets', () => {
    const cols = tableInfo('asset_tags')
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['account_id', 'source', 'source_id', 'tag'].sort()
    )
    const fk = db.prepare(`PRAGMA foreign_key_list(asset_tags)`).all() as Array<{
      table: string
      from: string
      to: string
    }>
    expect(fk.length).toBeGreaterThan(0)
    expect(fk[0].table).toBe('assets')
  })

  it('creates a sync_state table keyed by (account_id, source)', () => {
    const cols = tableInfo('sync_state')
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['account_id', 'source', 'last_sync_at', 'last_sync_status', 'last_sync_error'].sort()
    )
    expect(cols.find((c) => c.name === 'account_id')?.pk).toBe(1)
    expect(cols.find((c) => c.name === 'source')?.pk).toBe(2)
  })

  it('creates an accounts table', () => {
    const cols = tableInfo('accounts')
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['id', 'display_name', 'created_at', 'last_used_at'].sort()
    )
    expect(cols.find((c) => c.name === 'id')?.pk).toBe(1)
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

describe('migration v5 (Fab library filters)', () => {
  it('adds the filter columns and bumps user_version to 5', () => {
    const cols = (db.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols).toEqual(
      expect.arrayContaining(['fab_listing_uid', 'last_updated_at', 'licenses', 'engine_versions'])
    )
    expect(db.pragma('user_version', { simple: true })).toBe(5)
  })

  it('backfills fab-ue rows from raw and deletes fab-other rows with their tags', () => {
    db.pragma('user_version = 4')
    const insert = db.prepare(
      `INSERT INTO assets (account_id, source, source_id, sub_source, title, raw, synced_at)
       VALUES ('acc', 'fab', ?, ?, ?, ?, 0)`
    )
    insert.run(
      'ue-1',
      'fab-ue',
      'UE One',
      JSON.stringify({
        customAttributes: [{ ListingIdentifier: 'listing-1' }],
        projectVersions: [{ engineVersions: ['UE_5.3', 'UE_5.4'] }]
      })
    )
    insert.run('ue-2', 'fab-ue', 'UE Broken', '{not json')
    insert.run('other-1', 'fab-other', 'Blender Pack', '{}')
    db.prepare(
      `INSERT INTO asset_tags (account_id, source, source_id, tag) VALUES ('acc', 'fab', 'other-1', 'x')`
    ).run()

    applySchema(db)

    const ue1 = db
      .prepare(`SELECT fab_listing_uid, engine_versions FROM assets WHERE source_id = 'ue-1'`)
      .get() as { fab_listing_uid: string; engine_versions: string }
    expect(ue1).toEqual({ fab_listing_uid: 'listing-1', engine_versions: '["5.4","5.3"]' })
    const ue2 = db
      .prepare(`SELECT fab_listing_uid FROM assets WHERE source_id = 'ue-2'`)
      .get() as { fab_listing_uid: string | null }
    expect(ue2.fab_listing_uid).toBeNull()
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM assets WHERE sub_source = 'fab-other'`).get()
    ).toEqual({ n: 0 })
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM asset_tags WHERE source_id = 'other-1'`).get()
    ).toEqual({ n: 0 })
    expect(db.pragma('user_version', { simple: true })).toBe(5)
  })

  it('does not re-run once at v5', () => {
    db.prepare(
      `INSERT INTO assets (account_id, source, source_id, sub_source, title, raw, synced_at)
       VALUES ('acc', 'fab', 'ue-9', 'fab-ue', 'T', '{"customAttributes":[{"ListingIdentifier":"z"}]}', 0)`
    ).run()
    applySchema(db)
    const row = db.prepare(`SELECT fab_listing_uid FROM assets WHERE source_id = 'ue-9'`).get() as {
      fab_listing_uid: string | null
    }
    expect(row.fab_listing_uid).toBeNull()
  })
})

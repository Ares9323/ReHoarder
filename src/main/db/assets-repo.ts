import type Database from 'better-sqlite3'

export type AssetSource = 'vault' | 'fab' | 'legacy'

export interface AssetRow {
  source: AssetSource
  sourceId: string
  title: string
  description: string | null
  imageUrl: string | null
  productUrl: string | null
  ownedAt: number | null
  hidden: boolean
  raw: string | null
  syncedAt: number
}

export interface ListFilters {
  source?: AssetSource
  search?: string
  includeHidden?: boolean
}

interface AssetRowDb {
  source: string
  source_id: string
  title: string
  description: string | null
  image_url: string | null
  product_url: string | null
  owned_at: number | null
  hidden: number
  raw: string | null
  synced_at: number
}

function fromDb(r: AssetRowDb): AssetRow {
  return {
    source: r.source as AssetSource,
    sourceId: r.source_id,
    title: r.title,
    description: r.description,
    imageUrl: r.image_url,
    productUrl: r.product_url,
    ownedAt: r.owned_at,
    hidden: r.hidden !== 0,
    raw: r.raw,
    syncedAt: r.synced_at
  }
}

export class AssetsRepo {
  private readonly upsertStmt: Database.Statement
  private readonly findByIdStmt: Database.Statement
  private readonly setHiddenStmt: Database.Statement
  private readonly countAllStmt: Database.Statement
  private readonly countBySourceStmt: Database.Statement
  private readonly knownIdsStmt: Database.Statement
  private readonly addTagStmt: Database.Statement
  private readonly removeTagStmt: Database.Statement
  private readonly getTagsStmt: Database.Statement
  private readonly getAllTagsStmt: Database.Statement

  constructor(public readonly db: Database.Database) {
    // Upsert preserves the existing `hidden` flag on conflict so sync doesn't
    // resurrect assets the user explicitly hid.
    this.upsertStmt = db.prepare(`
      INSERT INTO assets (source, source_id, title, description, image_url, product_url, owned_at, hidden, raw, synced_at)
      VALUES (@source, @source_id, @title, @description, @image_url, @product_url, @owned_at, @hidden, @raw, @synced_at)
      ON CONFLICT(source, source_id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        image_url = excluded.image_url,
        product_url = excluded.product_url,
        owned_at = COALESCE(excluded.owned_at, owned_at),
        raw = excluded.raw,
        synced_at = excluded.synced_at
    `)

    this.findByIdStmt = db.prepare('SELECT * FROM assets WHERE source = ? AND source_id = ?')
    this.setHiddenStmt = db.prepare(
      'UPDATE assets SET hidden = ? WHERE source = ? AND source_id = ?'
    )
    this.countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM assets')
    this.countBySourceStmt = db.prepare('SELECT source, COUNT(*) AS n FROM assets GROUP BY source')
    this.knownIdsStmt = db.prepare('SELECT source_id FROM assets WHERE source = ?')
    this.addTagStmt = db.prepare(
      'INSERT OR IGNORE INTO asset_tags (source, source_id, tag) VALUES (?, ?, ?)'
    )
    this.removeTagStmt = db.prepare(
      'DELETE FROM asset_tags WHERE source = ? AND source_id = ? AND tag = ?'
    )
    this.getTagsStmt = db.prepare(
      'SELECT tag FROM asset_tags WHERE source = ? AND source_id = ? ORDER BY tag ASC'
    )
    this.getAllTagsStmt = db.prepare('SELECT DISTINCT tag FROM asset_tags ORDER BY tag ASC')
  }

  upsert(asset: AssetRow): void {
    this.upsertStmt.run({
      source: asset.source,
      source_id: asset.sourceId,
      title: asset.title,
      description: asset.description,
      image_url: asset.imageUrl,
      product_url: asset.productUrl,
      owned_at: asset.ownedAt,
      hidden: asset.hidden ? 1 : 0,
      raw: asset.raw,
      synced_at: asset.syncedAt
    })
  }

  findById(source: AssetSource, sourceId: string): AssetRow | null {
    const row = this.findByIdStmt.get(source, sourceId) as AssetRowDb | undefined
    return row ? fromDb(row) : null
  }

  list(filters: ListFilters): AssetRow[] {
    const clauses: string[] = []
    const params: unknown[] = []

    if (!filters.includeHidden) {
      clauses.push('hidden = 0')
    }
    if (filters.source) {
      clauses.push('source = ?')
      params.push(filters.source)
    }
    if (filters.search && filters.search.trim().length > 0) {
      clauses.push("(LOWER(title) LIKE ? OR LOWER(IFNULL(description, '')) LIKE ?)")
      const like = `%${filters.search.trim().toLowerCase()}%`
      params.push(like, like)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const sql = `SELECT * FROM assets ${where} ORDER BY title ASC`
    const rows = this.db.prepare(sql).all(...params) as AssetRowDb[]
    return rows.map(fromDb)
  }

  setHidden(source: AssetSource, sourceId: string, hidden: boolean): void {
    this.setHiddenStmt.run(hidden ? 1 : 0, source, sourceId)
  }

  countAll(): number {
    return (this.countAllStmt.get() as { n: number }).n
  }

  countBySource(): Record<string, number> {
    const rows = this.countBySourceStmt.all() as Array<{ source: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.source, r.n]))
  }

  /**
   * Returns the set of `source_id`s already persisted for the given source.
   * Used by the sync layer to drive incremental pagination — once a Fab
   * page contains only known IDs we can stop fetching further pages.
   */
  knownSourceIds(source: AssetSource): Set<string> {
    const rows = this.knownIdsStmt.all(source) as Array<{ source_id: string }>
    return new Set(rows.map((r) => r.source_id))
  }

  addTag(source: AssetSource, sourceId: string, tag: string): void {
    this.addTagStmt.run(source, sourceId, tag)
  }

  removeTag(source: AssetSource, sourceId: string, tag: string): void {
    this.removeTagStmt.run(source, sourceId, tag)
  }

  getTags(source: AssetSource, sourceId: string): string[] {
    const rows = this.getTagsStmt.all(source, sourceId) as Array<{ tag: string }>
    return rows.map((r) => r.tag)
  }

  getAllTags(): string[] {
    const rows = this.getAllTagsStmt.all() as Array<{ tag: string }>
    return rows.map((r) => r.tag)
  }
}

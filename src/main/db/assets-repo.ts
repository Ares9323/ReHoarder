import type Database from 'better-sqlite3'

export type AssetSource = 'vault' | 'fab' | 'legacy'
/** Sub-bucket within `source = 'fab'`. `null` for `source = 'vault'`. */
export type AssetSubSource = 'fab-ue' | 'fab-other' | null

export interface AssetRow {
  source: AssetSource
  sourceId: string
  subSource: AssetSubSource
  /** Fab "listing type" slug (`3d-model`, `animation`, …) — null for Vault. */
  listingType: string | null
  title: string
  description: string | null
  imageUrl: string | null
  productUrl: string | null
  ownedAt: number | null
  hidden: boolean
  bookmarked: boolean
  /** Display name of the seller / publisher / developer — `raw.seller` for Fab UE, `raw.publisher.sellerName` for Fab Other, `raw.catalog.developer` for Vault. Null when the upstream payload doesn't carry it. */
  seller: string | null
  raw: string | null
  syncedAt: number
}

export interface ListFilters {
  source?: AssetSource
  /** When set, narrows `fab` to either `fab-ue` or `fab-other`. Ignored for other sources. */
  subSource?: 'fab-ue' | 'fab-other'
  /** Fab listing-type slug (e.g. `3d-model`). When set, rows without that listing_type are excluded. */
  listingType?: string
  /** Fab category slug (e.g. `abandoned`). When set, only assets with that category in `asset_tags` are returned. */
  category?: string
  search?: string
  /** If `true`, hidden rows are included in the result. Default `false`. */
  includeHidden?: boolean
  /** If `true`, ONLY hidden rows are returned (overrides `includeHidden`). */
  onlyHidden?: boolean
  /** If `true`, ONLY bookmarked rows are returned. */
  onlyBookmarked?: boolean
}

interface AssetRowDb {
  source: string
  source_id: string
  sub_source: string | null
  listing_type: string | null
  title: string
  description: string | null
  image_url: string | null
  product_url: string | null
  owned_at: number | null
  hidden: number
  bookmarked: number
  seller: string | null
  raw: string | null
  synced_at: number
}

function fromDb(r: AssetRowDb): AssetRow {
  const sub: AssetSubSource =
    r.sub_source === 'fab-ue' || r.sub_source === 'fab-other' ? r.sub_source : null
  return {
    source: r.source as AssetSource,
    sourceId: r.source_id,
    subSource: sub,
    listingType: r.listing_type,
    title: r.title,
    description: r.description,
    imageUrl: r.image_url,
    productUrl: r.product_url,
    ownedAt: r.owned_at,
    hidden: r.hidden !== 0,
    bookmarked: r.bookmarked !== 0,
    seller: r.seller,
    raw: r.raw,
    syncedAt: r.synced_at
  }
}

export class AssetsRepo {
  private readonly upsertStmt: Database.Statement
  private readonly findByIdStmt: Database.Statement
  private readonly setHiddenStmt: Database.Statement
  private readonly setBookmarkedStmt: Database.Statement
  private readonly countAllStmt: Database.Statement
  private readonly countBySourceStmt: Database.Statement
  private readonly knownIdsStmt: Database.Statement
  private readonly addTagStmt: Database.Statement
  private readonly removeTagStmt: Database.Statement
  private readonly getTagsStmt: Database.Statement
  private readonly getAllTagsStmt: Database.Statement

  constructor(public readonly db: Database.Database) {
    // Upsert preserves the existing `hidden` and `bookmarked` flags on conflict
    // so sync doesn't undo user-driven state on previously-known assets.
    // `sub_source` IS refreshed: sync derives it from the raw payload and
    // overwriting keeps it consistent with the source endpoint the row came from.
    this.upsertStmt = db.prepare(`
      INSERT INTO assets (source, source_id, sub_source, listing_type, title, description, image_url, product_url, owned_at, hidden, bookmarked, seller, raw, synced_at)
      VALUES (@source, @source_id, @sub_source, @listing_type, @title, @description, @image_url, @product_url, @owned_at, @hidden, @bookmarked, @seller, @raw, @synced_at)
      ON CONFLICT(source, source_id) DO UPDATE SET
        sub_source = excluded.sub_source,
        listing_type = excluded.listing_type,
        title = excluded.title,
        description = excluded.description,
        image_url = excluded.image_url,
        product_url = excluded.product_url,
        owned_at = COALESCE(excluded.owned_at, owned_at),
        seller = excluded.seller,
        raw = excluded.raw,
        synced_at = excluded.synced_at
    `)

    this.findByIdStmt = db.prepare('SELECT * FROM assets WHERE source = ? AND source_id = ?')
    this.setHiddenStmt = db.prepare(
      'UPDATE assets SET hidden = ? WHERE source = ? AND source_id = ?'
    )
    this.setBookmarkedStmt = db.prepare(
      'UPDATE assets SET bookmarked = ? WHERE source = ? AND source_id = ?'
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
      sub_source: asset.subSource,
      listing_type: asset.listingType,
      title: asset.title,
      description: asset.description,
      image_url: asset.imageUrl,
      product_url: asset.productUrl,
      owned_at: asset.ownedAt,
      hidden: asset.hidden ? 1 : 0,
      bookmarked: asset.bookmarked ? 1 : 0,
      seller: asset.seller,
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

    if (filters.onlyHidden) {
      clauses.push('hidden = 1')
    } else if (!filters.includeHidden) {
      clauses.push('hidden = 0')
    }
    if (filters.onlyBookmarked) {
      clauses.push('bookmarked = 1')
    }
    if (filters.source) {
      clauses.push('source = ?')
      params.push(filters.source)
    } else {
      // Vault assets aren't downloadable: Epic shut down the legacy Marketplace
      // CDN scope (`launcher:download:Live-Windows:<appName>` is no longer
      // granted to public clients). Sync still indexes them so they're around
      // if Epic ever reopens that path, but the UI hides them by default —
      // an explicit `source = 'vault'` filter is the only way to surface them.
      clauses.push("source != 'vault'")
    }
    if (filters.subSource) {
      clauses.push('sub_source = ?')
      params.push(filters.subSource)
    }
    if (filters.listingType) {
      clauses.push('listing_type = ?')
      params.push(filters.listingType)
    }
    if (filters.category) {
      clauses.push(
        `EXISTS (
           SELECT 1 FROM asset_tags AS t
            WHERE t.source = assets.source
              AND t.source_id = assets.source_id
              AND t.tag = ?
         )`
      )
      params.push(filters.category)
    }
    if (filters.search && filters.search.trim().length > 0) {
      // Match on title, description AND seller — so a query like "infinity pbr"
      // surfaces every asset by that creator in addition to titles that
      // happen to contain the phrase.
      clauses.push(
        "(LOWER(title) LIKE ? OR LOWER(IFNULL(description, '')) LIKE ? OR LOWER(IFNULL(seller, '')) LIKE ?)"
      )
      const like = `%${filters.search.trim().toLowerCase()}%`
      params.push(like, like, like)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const sql = `SELECT * FROM assets ${where} ORDER BY title ASC`
    const rows = this.db.prepare(sql).all(...params) as AssetRowDb[]
    return rows.map(fromDb)
  }

  setHidden(source: AssetSource, sourceId: string, hidden: boolean): void {
    this.setHiddenStmt.run(hidden ? 1 : 0, source, sourceId)
  }

  setBookmarked(source: AssetSource, sourceId: string, bookmarked: boolean): void {
    this.setBookmarkedStmt.run(bookmarked ? 1 : 0, source, sourceId)
  }

  countAll(): number {
    return (this.countAllStmt.get() as { n: number }).n
  }

  /** Distinct, non-null `listing_type` values currently present in `assets`, sorted alphabetically. */
  availableListingTypes(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT listing_type AS t
           FROM assets
          WHERE listing_type IS NOT NULL
          ORDER BY t ASC`
      )
      .all() as Array<{ t: string }>
    return rows.map((r) => r.t)
  }

  /**
   * Distinct category tags currently present in `asset_tags`, EXCLUDING the
   * canonical Fab listing-type slugs (which live in their own dropdown). Sorted
   * alphabetically — populates the third filter dropdown in the renderer.
   */
  availableCategories(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT tag
           FROM asset_tags
          WHERE tag NOT IN (
            '3d-model','animation','audio','game-system','game-template',
            'material','tool-and-plugin','tutorials-examples','ui','vfx'
          )
          ORDER BY tag ASC`
      )
      .all() as Array<{ tag: string }>
    return rows.map((r) => r.tag)
  }

  /**
   * Replace the full tag set of one asset in a single transaction. Used by the
   * sync layer after every `upsert()` so tags stay in lockstep with the raw
   * payload — categories added or removed upstream are mirrored exactly.
   */
  replaceTags(source: AssetSource, sourceId: string, tags: string[]): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM asset_tags WHERE source = ? AND source_id = ?')
        .run(source, sourceId)
      for (const tag of tags) {
        if (!tag) continue
        this.addTagStmt.run(source, sourceId, tag.toLowerCase())
      }
    })
    txn()
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

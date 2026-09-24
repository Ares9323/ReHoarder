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
  /** Last time `/i/listings/<uid>` was queried for this asset and `image_url`
   *  was refreshed. Null = never. Drives the post-sync rolling refresh
   *  queue's "oldest first" pick. */
  lastPreciseAt: number | null
}

/** Per-listing data from the Fab entitlements pass (`/i/library/search`). */
export interface FabEntitlementInfo {
  /** Acquisition time (epoch ms). */
  ownedAt: number | null
  /** Last listing update on Fab (epoch ms). */
  lastUpdatedAt: number | null
  /** Owned license slugs, sorted (`personal`, `professional`, `legacy-uem`, ...). */
  licenses: string[]
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
  last_precise_at: number | null
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
    syncedAt: r.synced_at,
    lastPreciseAt: r.last_precise_at
  }
}

/** Resolves the currently active Epic account id at query time. Returning
 *  `null` means "no active account", and every method on the repo treats
 *  that as an empty data set (no rows match). The repo never mutates this
 *  function — it's a snapshot the caller controls. */
export type AccountIdGetter = () => string | null

export class AssetsRepo {
  private readonly upsertStmt: Database.Statement
  private readonly findByIdStmt: Database.Statement
  private readonly setHiddenStmt: Database.Statement
  private readonly setBookmarkedStmt: Database.Statement
  private readonly updateImageUrlAndPreciseAtStmt: Database.Statement
  private readonly countAllStmt: Database.Statement
  private readonly countBySourceStmt: Database.Statement
  private readonly knownIdsStmt: Database.Statement
  private readonly addTagStmt: Database.Statement
  private readonly removeTagStmt: Database.Statement
  private readonly getTagsStmt: Database.Statement
  private readonly getAllTagsStmt: Database.Statement

  constructor(
    public readonly db: Database.Database,
    private readonly getActiveAccountId: AccountIdGetter
  ) {
    // Upsert preserves the existing `hidden` and `bookmarked` flags on conflict
    // so sync doesn't undo user-driven state on previously-known assets.
    // `sub_source` IS refreshed: sync derives it from the raw payload and
    // overwriting keeps it consistent with the source endpoint the row came from.
    this.upsertStmt = db.prepare(`
      INSERT INTO assets (account_id, source, source_id, sub_source, listing_type, title, description, image_url, product_url, owned_at, hidden, bookmarked, seller, raw, synced_at)
      VALUES (@account_id, @source, @source_id, @sub_source, @listing_type, @title, @description, @image_url, @product_url, @owned_at, @hidden, @bookmarked, @seller, @raw, @synced_at)
      ON CONFLICT(account_id, source, source_id) DO UPDATE SET
        sub_source = excluded.sub_source,
        listing_type = excluded.listing_type,
        title = excluded.title,
        description = excluded.description,
        -- Preserve image_url when the row has been touched by the
        -- listing-detail flow (last_precise_at IS NOT NULL). Otherwise the
        -- next library-endpoint sync would clobber the fresher value the
        -- detail endpoint provided — every per-asset right-click refresh
        -- and every rolling background refresh would lose its effect on the
        -- next manual Sync now click.
        image_url = CASE
          WHEN assets.last_precise_at IS NULL THEN excluded.image_url
          ELSE assets.image_url
        END,
        product_url = excluded.product_url,
        owned_at = COALESCE(excluded.owned_at, owned_at),
        seller = excluded.seller,
        raw = excluded.raw,
        synced_at = excluded.synced_at
    `)

    this.findByIdStmt = db.prepare(
      'SELECT * FROM assets WHERE account_id = ? AND source = ? AND source_id = ?'
    )
    this.setHiddenStmt = db.prepare(
      'UPDATE assets SET hidden = ? WHERE account_id = ? AND source = ? AND source_id = ?'
    )
    this.setBookmarkedStmt = db.prepare(
      'UPDATE assets SET bookmarked = ? WHERE account_id = ? AND source = ? AND source_id = ?'
    )
    this.updateImageUrlAndPreciseAtStmt = db.prepare(
      `UPDATE assets
         SET image_url = ?, last_precise_at = ?
         WHERE account_id = ? AND source = ? AND source_id = ?`
    )
    this.countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE account_id = ?')
    this.countBySourceStmt = db.prepare(
      'SELECT source, COUNT(*) AS n FROM assets WHERE account_id = ? GROUP BY source'
    )
    this.knownIdsStmt = db.prepare(
      'SELECT source_id FROM assets WHERE account_id = ? AND source = ?'
    )
    this.addTagStmt = db.prepare(
      'INSERT OR IGNORE INTO asset_tags (account_id, source, source_id, tag) VALUES (?, ?, ?, ?)'
    )
    this.removeTagStmt = db.prepare(
      'DELETE FROM asset_tags WHERE account_id = ? AND source = ? AND source_id = ? AND tag = ?'
    )
    this.getTagsStmt = db.prepare(
      'SELECT tag FROM asset_tags WHERE account_id = ? AND source = ? AND source_id = ? ORDER BY tag ASC'
    )
    this.getAllTagsStmt = db.prepare(
      'SELECT DISTINCT tag FROM asset_tags WHERE account_id = ? ORDER BY tag ASC'
    )
  }

  private accountOrEmpty(): string | null {
    return this.getActiveAccountId()
  }

  upsert(asset: AssetRow): void {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return
    this.upsertStmt.run({
      account_id: accountId,
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
    const accountId = this.accountOrEmpty()
    if (accountId === null) return null
    const row = this.findByIdStmt.get(accountId, source, sourceId) as AssetRowDb | undefined
    return row ? fromDb(row) : null
  }

  list(filters: ListFilters): AssetRow[] {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return []
    const clauses: string[] = ['account_id = ?']
    const params: unknown[] = [accountId]

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
    } else {
      // Same reasoning as the vault exclusion above, one library over: Fab
      // "Other" listings (UEFN, Blender, Maya, FBX, MetaHuman, Unity, …) carry
      // no `assetNamespace` / `projectVersions[].artifactId`, so there is
      // nothing for the downloader to fetch — UEFN content isn't even
      // downloadable from fab.com, it's delivered inside Unreal Editor for
      // Fortnite. Sync keeps indexing them, but they stay out of the default
      // view; `subSource = 'fab-other'` ("Only Fab Other") surfaces them.
      //
      // The `IS NULL` arm matters: `sub_source != 'fab-other'` alone evaluates
      // to NULL (and therefore filters out) vault and legacy rows, which have
      // no sub_source at all.
      clauses.push("(sub_source IS NULL OR sub_source != 'fab-other')")
    }
    if (filters.listingType) {
      clauses.push('listing_type = ?')
      params.push(filters.listingType)
    }
    if (filters.category) {
      clauses.push(
        `EXISTS (
           SELECT 1 FROM asset_tags AS t
            WHERE t.account_id = assets.account_id
              AND t.source = assets.source
              AND t.source_id = assets.source_id
              AND t.tag = ?
         )`
      )
      params.push(filters.category)
    }
    if (filters.search && filters.search.trim().length > 0) {
      // Tokenise on whitespace: every token must match somewhere across
      // title / description / seller, but tokens can hit different fields.
      // So "laya cry" surfaces "Crystal cave" by "Laya design" (one token in
      // seller, one in title) — which a single LIKE '%laya cry%' would miss.
      // LIKE wildcards (`%` / `_`) in the user query are escaped so a literal
      // "100%" search means what it says.
      const tokens = filters.search.trim().toLowerCase().split(/\s+/)
      for (const tok of tokens) {
        const escaped = tok.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&')
        clauses.push(
          "(LOWER(title) LIKE ? ESCAPE '\\'" +
            " OR LOWER(IFNULL(description, '')) LIKE ? ESCAPE '\\'" +
            " OR LOWER(IFNULL(seller, '')) LIKE ? ESCAPE '\\')"
        )
        const like = `%${escaped}%`
        params.push(like, like, like)
      }
    }

    const where = `WHERE ${clauses.join(' AND ')}`
    const sql = `SELECT * FROM assets ${where} ORDER BY title ASC`
    const rows = this.db.prepare(sql).all(...params) as AssetRowDb[]
    return rows.map(fromDb)
  }

  setHidden(source: AssetSource, sourceId: string, hidden: boolean): void {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return
    this.setHiddenStmt.run(hidden ? 1 : 0, accountId, source, sourceId)
  }

  setBookmarked(source: AssetSource, sourceId: string, bookmarked: boolean): void {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return
    this.setBookmarkedStmt.run(bookmarked ? 1 : 0, accountId, source, sourceId)
  }

  /**
   * Targeted update used by `Sync.refreshAssetFromFab` (the right-click
   * "Refresh from Fab" flow). Writes both `image_url` and stamps
   * `last_precise_at` so the upsert's CASE WHEN preservation rule knows to
   * leave this row's `image_url` alone on the next sync — otherwise the
   * library endpoint's stale snapshot would clobber the user's fresh pick.
   */
  updateImageUrlAndPreciseAt(
    source: AssetSource,
    sourceId: string,
    imageUrl: string | null,
    at: number
  ): boolean {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return false
    const r = this.updateImageUrlAndPreciseAtStmt.run(imageUrl, at, accountId, source, sourceId)
    return (r.changes ?? 0) > 0
  }

  countAll(): number {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return 0
    return (this.countAllStmt.get(accountId) as { n: number }).n
  }

  /** Distinct, non-null `listing_type` values currently present in `assets`, sorted alphabetically. */
  availableListingTypes(): string[] {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return []
    const rows = this.db
      .prepare(
        `SELECT DISTINCT listing_type AS t
           FROM assets
          WHERE account_id = ?
            AND listing_type IS NOT NULL
          ORDER BY t ASC`
      )
      .all(accountId) as Array<{ t: string }>
    return rows.map((r) => r.t)
  }

  /**
   * Distinct category tags currently present in `asset_tags`, EXCLUDING the
   * canonical Fab listing-type slugs (which live in their own dropdown). Sorted
   * alphabetically — populates the third filter dropdown in the renderer.
   */
  availableCategories(): string[] {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return []
    const rows = this.db
      .prepare(
        `SELECT DISTINCT tag
           FROM asset_tags
          WHERE account_id = ?
            AND tag NOT IN (
              '3d-model','animation','audio','game-system','game-template',
              'material','tool-and-plugin','tutorials-examples','ui','vfx'
            )
          ORDER BY tag ASC`
      )
      .all(accountId) as Array<{ tag: string }>
    return rows.map((r) => r.tag)
  }

  /**
   * Replace the full tag set of one asset in a single transaction. Used by the
   * sync layer after every `upsert()` so tags stay in lockstep with the raw
   * payload — categories added or removed upstream are mirrored exactly.
   */
  replaceTags(source: AssetSource, sourceId: string, tags: string[]): void {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM asset_tags WHERE account_id = ? AND source = ? AND source_id = ?'
        )
        .run(accountId, source, sourceId)
      for (const tag of tags) {
        if (!tag) continue
        this.addTagStmt.run(accountId, source, sourceId, tag.toLowerCase())
      }
    })
    txn()
  }

  countBySource(): Record<string, number> {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return {}
    const rows = this.countBySourceStmt.all(accountId) as Array<{ source: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.source, r.n]))
  }

  /**
   * Returns the set of `source_id`s already persisted for the given source.
   * Used by the sync layer to drive incremental pagination — once a Fab
   * page contains only known IDs we can stop fetching further pages.
   */
  knownSourceIds(source: AssetSource): Set<string> {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return new Set()
    const rows = this.knownIdsStmt.all(accountId, source) as Array<{ source_id: string }>
    return new Set(rows.map((r) => r.source_id))
  }

  addTag(source: AssetSource, sourceId: string, tag: string): void {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return
    this.addTagStmt.run(accountId, source, sourceId, tag)
  }

  removeTag(source: AssetSource, sourceId: string, tag: string): void {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return
    this.removeTagStmt.run(accountId, source, sourceId, tag)
  }

  getTags(source: AssetSource, sourceId: string): string[] {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return []
    const rows = this.getTagsStmt.all(accountId, source, sourceId) as Array<{ tag: string }>
    return rows.map((r) => r.tag)
  }

  getAllTags(): string[] {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return []
    const rows = this.getAllTagsStmt.all(accountId) as Array<{ tag: string }>
    return rows.map((r) => r.tag)
  }
}

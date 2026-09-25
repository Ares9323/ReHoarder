import type Database from 'better-sqlite3'
import {
  compareEngineVersionsDesc,
  parseJsonStringArray,
  toJsonArrayOrNull
} from '../fab/fab-listing-fields'

export type AssetSource = 'vault' | 'fab' | 'legacy'
/** Sub-bucket within `source = 'fab'`. `null` for `source = 'vault'`. */
export type AssetSubSource = 'fab-ue' | null

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
  /** Display name of the seller / publisher / developer: `raw.seller` for Fab UE, `raw.catalog.developer` for Vault. Null when the upstream payload doesn't carry it. */
  seller: string | null
  raw: string | null
  syncedAt: number
  /** Last time `/i/listings/<uid>` was queried for this asset and `image_url`
   *  was refreshed. Null = never. Drives the post-sync rolling refresh
   *  queue's "oldest first" pick. */
  lastPreciseAt: number | null
  /** Fab listing uid (`customAttributes.ListingIdentifier`), join key for the entitlements pass. Fab UE only. */
  fabListingUid?: string | null
  /** Supported engine versions (`5.4`, ...), newest first. Fab UE only. */
  engineVersions?: string[]
  /** Last listing update on Fab (epoch ms), from the entitlements pass. */
  lastUpdatedAt?: number | null
  /** Owned license slugs, from the entitlements pass. */
  licenses?: string[]
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

export type AssetSort = 'newest' | 'oldest' | 'title-asc' | 'title-desc' | 'last-updated'

/** Whitelisted ORDER BY clauses. Undated rows go last under every date sort. */
const ORDER_BY: Record<AssetSort, string> = {
  newest: 'owned_at DESC NULLS LAST, title ASC',
  oldest: 'owned_at ASC NULLS LAST, title ASC',
  'title-asc': 'title ASC',
  'title-desc': 'title DESC',
  'last-updated': 'last_updated_at DESC NULLS LAST, title ASC'
}

export interface ListFilters {
  source?: AssetSource
  /** When set, narrows `fab` to `fab-ue` rows. Ignored for other sources. */
  subSource?: 'fab-ue'
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
  /** Result order. Unknown values fall back to `title-asc`. */
  sort?: AssetSort
  /** Exact seller / publisher name. */
  seller?: string
  /** License slug that must be among the owned licenses (`personal`, `legacy-uem`, ...). */
  license?: string
  /** Engine version (`5.4`) the asset must support. */
  engineVersion?: string
  /** Only assets acquired at or after this epoch ms. */
  ownedSince?: number
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
  fab_listing_uid: string | null
  engine_versions: string | null
  last_updated_at: number | null
  licenses: string | null
}

function fromDb(r: AssetRowDb): AssetRow {
  const sub: AssetSubSource = r.sub_source === 'fab-ue' ? 'fab-ue' : null
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
    lastPreciseAt: r.last_precise_at,
    fabListingUid: r.fab_listing_uid,
    engineVersions: parseJsonStringArray(r.engine_versions),
    lastUpdatedAt: r.last_updated_at,
    licenses: parseJsonStringArray(r.licenses)
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
      INSERT INTO assets (account_id, source, source_id, sub_source, listing_type, title, description, image_url, product_url, owned_at, hidden, bookmarked, seller, raw, synced_at, fab_listing_uid, engine_versions)
      VALUES (@account_id, @source, @source_id, @sub_source, @listing_type, @title, @description, @image_url, @product_url, @owned_at, @hidden, @bookmarked, @seller, @raw, @synced_at, @fab_listing_uid, @engine_versions)
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
        synced_at = excluded.synced_at,
        fab_listing_uid = excluded.fab_listing_uid,
        engine_versions = excluded.engine_versions
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
      synced_at: asset.syncedAt,
      fab_listing_uid: asset.fabListingUid ?? null,
      engine_versions: toJsonArrayOrNull(asset.engineVersions ?? [])
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
    if (filters.seller) {
      clauses.push('seller = ?')
      params.push(filters.seller)
    }
    if (filters.license) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(assets.licenses) WHERE value = ?)')
      params.push(filters.license)
    }
    if (filters.engineVersion) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(assets.engine_versions) WHERE value = ?)')
      params.push(filters.engineVersion)
    }
    if (typeof filters.ownedSince === 'number') {
      clauses.push('owned_at >= ?')
      params.push(filters.ownedSince)
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
    const orderBy = ORDER_BY[filters.sort ?? 'title-asc'] ?? ORDER_BY['title-asc']
    const sql = `SELECT * FROM assets ${where} ORDER BY ${orderBy}`
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

  /**
   * Write the entitlements pass results onto the matching Fab rows in one
   * transaction, joined on `fab_listing_uid`. `owned_at` keeps its previous
   * value when the entitlement has no `createdAt`. Returns how many listing
   * uids matched a row; the rest are acquisitions the UE library does not
   * list (yet).
   */
  applyFabEntitlements(entitlements: Map<string, FabEntitlementInfo>): {
    matched: number
    unmatched: number
  } {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return { matched: 0, unmatched: entitlements.size }
    const stmt = this.db.prepare(
      `UPDATE assets
          SET owned_at = COALESCE(?, owned_at), last_updated_at = ?, licenses = ?
        WHERE account_id = ? AND source = 'fab' AND fab_listing_uid = ?`
    )
    let matched = 0
    const txn = this.db.transaction(() => {
      for (const [listingUid, info] of entitlements) {
        const r = stmt.run(
          info.ownedAt,
          info.lastUpdatedAt,
          toJsonArrayOrNull(info.licenses),
          accountId,
          listingUid
        )
        if (r.changes > 0) matched += 1
      }
    })
    txn()
    return { matched, unmatched: entitlements.size - matched }
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

  /** Distinct Fab sellers, case-insensitive A-Z. Feeds the Publisher suggestions. */
  availableSellers(): string[] {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return []
    const rows = this.db
      .prepare(
        `SELECT DISTINCT seller AS s
           FROM assets
          WHERE account_id = ? AND source = 'fab' AND seller IS NOT NULL
          ORDER BY s COLLATE NOCASE ASC`
      )
      .all(accountId) as Array<{ s: string }>
    return rows.map((r) => r.s)
  }

  /** Distinct owned license slugs across Fab assets, A-Z. */
  availableLicenses(): string[] {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return []
    const rows = this.db
      .prepare(
        `SELECT DISTINCT j.value AS l
           FROM assets, json_each(assets.licenses) AS j
          WHERE assets.account_id = ? AND assets.source = 'fab'
          ORDER BY l ASC`
      )
      .all(accountId) as Array<{ l: string }>
    return rows.map((r) => r.l)
  }

  /** Distinct supported engine versions across Fab assets, newest first. */
  availableEngineVersions(): string[] {
    const accountId = this.accountOrEmpty()
    if (accountId === null) return []
    const rows = this.db
      .prepare(
        `SELECT DISTINCT j.value AS v
           FROM assets, json_each(assets.engine_versions) AS j
          WHERE assets.account_id = ? AND assets.source = 'fab'`
      )
      .all(accountId) as Array<{ v: string }>
    return rows.map((r) => r.v).sort(compareEngineVersionsDesc)
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

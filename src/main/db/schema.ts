import type Database from 'better-sqlite3'
import {
  FAB_DISTRIBUTION_TO_LISTING_TYPE,
  FAB_LISTING_TYPE_IDS,
  FAB_UE_PATH_TO_LISTING_TYPE,
  slugifyCategory
} from '../category-slug'
import {
  engineVersionsFromItem,
  fabListingUidFromItem,
  toJsonArrayOrNull
} from '../fab/fab-listing-fields'

/** Placeholder account id used to backfill pre-multi-account rows during the
 *  v3 → v4 migration. The single-account legacy data is bound to this id
 *  until the next successful login surfaces the real Epic account id, at
 *  which point `AccountsRepo.rebindLegacy(realId)` rewrites every row with
 *  `account_id = 'legacy'` to the real id. */
export const LEGACY_ACCOUNT_ID = 'legacy'

export function applySchema(db: Database.Database): void {
  // Order matters: create the base tables FIRST, then run migrations on top.
  // `tryAddColumn` silently no-ops "no such table" errors, so on a fresh DB
  // with the previous ordering the migrations would have skipped — leaving
  // `bookmarked` / `sub_source` / `listing_type` / `seller` missing until
  // the next launch. Creating first then migrating means a single launch
  // converges to the full schema for both fresh installs and upgrades.
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      account_id TEXT NOT NULL DEFAULT '${LEGACY_ACCOUNT_ID}',
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      product_url TEXT,
      owned_at INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0,
      seller TEXT,
      raw TEXT,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, source, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_assets_hidden ON assets (hidden);
    CREATE INDEX IF NOT EXISTS idx_assets_source ON assets (source);

    CREATE TABLE IF NOT EXISTS asset_tags (
      account_id TEXT NOT NULL DEFAULT '${LEGACY_ACCOUNT_ID}',
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (account_id, source, source_id, tag),
      FOREIGN KEY (account_id, source, source_id)
        REFERENCES assets(account_id, source, source_id)
        ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags (tag);

    CREATE TABLE IF NOT EXISTS sync_state (
      account_id TEXT NOT NULL DEFAULT '${LEGACY_ACCOUNT_ID}',
      source TEXT NOT NULL,
      last_sync_at INTEGER,
      last_sync_status TEXT,
      last_sync_error TEXT,
      PRIMARY KEY (account_id, source)
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL DEFAULT '${LEGACY_ACCOUNT_ID}',
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      bytes_done INTEGER NOT NULL DEFAULT 0,
      bytes_total INTEGER NOT NULL DEFAULT 0,
      files_done INTEGER NOT NULL DEFAULT 0,
      files_total INTEGER NOT NULL DEFAULT 0,
      current_file TEXT,
      dest_dir TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads (status);
    CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads (created_at DESC);
  `)
  applyMigrations(db)
}

/**
 * Forward-compatible additions to pre-existing tables. Each migration is
 * idempotent — `ALTER TABLE ADD COLUMN` throws when the column already
 * exists, so we swallow the "duplicate column name" error and move on.
 *
 * Keep this list append-only and never mutate previously-shipped rows.
 */
function applyMigrations(db: Database.Database): void {
  tryAddColumn(db, 'assets', 'bookmarked', 'INTEGER NOT NULL DEFAULT 0')
  tryAddColumn(db, 'assets', 'sub_source', 'TEXT')
  tryAddColumn(db, 'assets', 'listing_type', 'TEXT')
  tryAddColumn(db, 'assets', 'seller', 'TEXT')
  tryAddColumn(db, 'downloads', 'engine_version', 'TEXT')
  tryAddColumn(db, 'downloads', 'install_target_path', 'TEXT')
  tryAddColumn(db, 'downloads', 'build_version', 'TEXT')
  // Last `precise` refresh timestamp (ms): the most recent moment we
  // hit `/i/listings/<uid>` and updated `image_url` for this asset.
  // Used by the post-sync rolling refresh queue to pick the oldest
  // entries first. Null = never touched by the Refresh-from-Fab flow.
  tryAddColumn(db, 'assets', 'last_precise_at', 'INTEGER')
  backfillFabSubSource(db)
  backfillListingType(db)
  migrateCategoriesToSluggedNames(db)
  migrateFabUePathListingTypes(db)
  backfillSeller(db)
  migrateAccountScoping(db)
  // v5: columns backing the Assets sort/filter controls. Added after the v4
  // table rebuild so a pre-v4 upgrade does not drop them.
  tryAddColumn(db, 'assets', 'fab_listing_uid', 'TEXT')
  tryAddColumn(db, 'assets', 'last_updated_at', 'INTEGER')
  tryAddColumn(db, 'assets', 'licenses', 'TEXT')
  tryAddColumn(db, 'assets', 'engine_versions', 'TEXT')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_assets_fab_listing_uid ON assets (account_id, fab_listing_uid)'
  )
  migrateFabLibraryFilters(db)
}

/**
 * Migration v3 → v4: introduce per-account scoping. The original PKs were
 * `(source, source_id)` (assets), `(source, source_id, tag)` (asset_tags),
 * `(source)` (sync_state). Those would collide the moment a second account
 * owns the same listing or replays a sync. To keep cross-account isolation
 * watertight we **rebuild the tables** with `account_id` baked into the
 * primary key.
 *
 * Pre-existing rows are stamped with `account_id = 'legacy'`, and a matching
 * row is inserted in `accounts`. The next successful login flips every
 * `account_id = 'legacy'` to the real Epic account id (handled by
 * `AccountsRepo.rebindLegacy`), at which point the legacy slot is collapsed.
 *
 * `downloads` doesn't need a rebuild — its PK is a synthetic UUID `id`, so
 * the column is simply added with a default plus an index.
 */
function migrateAccountScoping(db: Database.Database): void {
  let v: number
  try {
    v = db.pragma('user_version', { simple: true }) as number
  } catch {
    v = 0
  }
  if (v >= 4) return

  const rebuildTx = db.transaction(() => {
    // 1. Stamp the legacy account row up front so post-rebuild rows have
    //    something to reference (we don't model an FK from assets to accounts,
    //    but this keeps repo lookups consistent).
    db.prepare(
      `INSERT OR IGNORE INTO accounts (id, display_name, created_at, last_used_at)
         VALUES (?, ?, ?, ?)`
    ).run(LEGACY_ACCOUNT_ID, '(legacy)', Date.now(), Date.now())

    // 2. Rebuild `assets` with `(account_id, source, source_id)` as the PK.
    //    Only run when the existing table lacks `account_id` — re-running
    //    after a partial failure shouldn't drop the rebuilt table.
    if (!hasColumn(db, 'assets', 'account_id')) {
      db.exec(`
        CREATE TABLE assets_v4 (
          account_id TEXT NOT NULL,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          image_url TEXT,
          product_url TEXT,
          owned_at INTEGER,
          hidden INTEGER NOT NULL DEFAULT 0,
          bookmarked INTEGER NOT NULL DEFAULT 0,
          sub_source TEXT,
          listing_type TEXT,
          seller TEXT,
          raw TEXT,
          synced_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, source, source_id)
        );
        INSERT INTO assets_v4
          (account_id, source, source_id, title, description, image_url, product_url,
           owned_at, hidden, bookmarked, sub_source, listing_type, seller, raw, synced_at)
          SELECT '${LEGACY_ACCOUNT_ID}', source, source_id, title, description, image_url,
                 product_url, owned_at, hidden,
                 COALESCE(bookmarked, 0),
                 sub_source, listing_type, seller, raw, synced_at
            FROM assets;
        DROP TABLE assets;
        ALTER TABLE assets_v4 RENAME TO assets;
        CREATE INDEX idx_assets_hidden ON assets (hidden);
        CREATE INDEX idx_assets_source ON assets (source);
        CREATE INDEX idx_assets_account ON assets (account_id);
      `)
    }

    // 3. Rebuild `asset_tags` with `(account_id, source, source_id, tag)` PK.
    if (!hasColumn(db, 'asset_tags', 'account_id')) {
      db.exec(`
        CREATE TABLE asset_tags_v4 (
          account_id TEXT NOT NULL,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (account_id, source, source_id, tag),
          FOREIGN KEY (account_id, source, source_id)
            REFERENCES assets(account_id, source, source_id)
            ON DELETE CASCADE ON UPDATE CASCADE
        );
        INSERT INTO asset_tags_v4 (account_id, source, source_id, tag)
          SELECT '${LEGACY_ACCOUNT_ID}', source, source_id, tag FROM asset_tags;
        DROP TABLE asset_tags;
        ALTER TABLE asset_tags_v4 RENAME TO asset_tags;
        CREATE INDEX idx_asset_tags_tag ON asset_tags (tag);
        CREATE INDEX idx_asset_tags_account ON asset_tags (account_id);
      `)
    }

    // 4. Rebuild `sync_state` with `(account_id, source)` PK.
    if (!hasColumn(db, 'sync_state', 'account_id')) {
      db.exec(`
        CREATE TABLE sync_state_v4 (
          account_id TEXT NOT NULL,
          source TEXT NOT NULL,
          last_sync_at INTEGER,
          last_sync_status TEXT,
          last_sync_error TEXT,
          PRIMARY KEY (account_id, source)
        );
        INSERT INTO sync_state_v4 (account_id, source, last_sync_at, last_sync_status, last_sync_error)
          SELECT '${LEGACY_ACCOUNT_ID}', source, last_sync_at, last_sync_status, last_sync_error
            FROM sync_state;
        DROP TABLE sync_state;
        ALTER TABLE sync_state_v4 RENAME TO sync_state;
      `)
    }

    // 5. `downloads` keeps its synthetic-UUID PK; just add account_id.
    if (!hasColumn(db, 'downloads', 'account_id')) {
      db.exec(
        `ALTER TABLE downloads ADD COLUMN account_id TEXT NOT NULL DEFAULT '${LEGACY_ACCOUNT_ID}'`
      )
    }

    // 6. account-scoped indexes — created here (rather than in `applySchema`)
    //    because the `account_id` column doesn't exist yet at applySchema time
    //    on legacy DBs (the rebuild/ALTER steps above add it). Idempotent so
    //    fresh installs reach the same state.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_assets_account ON assets (account_id);
      CREATE INDEX IF NOT EXISTS idx_asset_tags_account ON asset_tags (account_id);
      CREATE INDEX IF NOT EXISTS idx_downloads_account ON downloads (account_id);
    `)

    db.pragma('user_version = 4')
  })

  // SQLite forbids `PRAGMA foreign_keys = …` inside a transaction. The rebuild
  // transaction drops `assets`, which violates the FK from `asset_tags` while
  // the latter still exists, so we temporarily turn FK enforcement off for
  // the duration of the migration and restore it afterwards.
  let priorForeignKeys = 1
  try {
    priorForeignKeys = db.pragma('foreign_keys', { simple: true }) as number
  } catch {
    /* default ON */
  }
  try {
    db.pragma('foreign_keys = OFF')
    rebuildTx()
    console.warn('[schema] account_id PK rebuild + accounts table ready (user_version → 4)')
  } catch (err) {
    console.warn('[schema] account scoping migration skipped:', err)
  } finally {
    if (priorForeignKeys === 1) db.pragma('foreign_keys = ON')
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.some((r) => r.name === column)
  } catch {
    return false
  }
}

/**
 * For pre-existing `fab` rows without `sub_source`, derive the bucket from the
 * raw JSON shape: Fab UE listings carry `projectVersions`, Fab Other listings
 * carry `assetFormats`. Safe to re-run — only NULL rows are touched.
 */
function backfillFabSubSource(db: Database.Database): void {
  try {
    db.exec(`
      UPDATE assets
         SET sub_source = 'fab-ue'
       WHERE source = 'fab'
         AND sub_source IS NULL
         AND json_extract(raw, '$.projectVersions') IS NOT NULL
    `)
    db.exec(`
      UPDATE assets
         SET sub_source = 'fab-other'
       WHERE source = 'fab'
         AND sub_source IS NULL
         AND json_extract(raw, '$.assetFormats') IS NOT NULL
    `)
  } catch (err) {
    // older SQLite without json_extract — skip; new syncs will populate sub_source going forward
    console.warn('[schema] sub_source backfill skipped:', err)
  }
}

/**
 * Backfill `listing_type` for pre-existing Fab rows.
 *
 * Fab Other already carries `listing.listingType` verbatim, so we copy it
 * across. Fab UE listings don't have a single `listingType` field; they carry
 * `categories[]` and one of those category ids matches the canonical Fab
 * listing-type slug (`3d-model` / `animation` / `audio` / …). We pick the
 * first matching id. Skipped when SQLite lacks `json_each`.
 */
function backfillListingType(db: Database.Database): void {
  try {
    db.exec(`
      UPDATE assets
         SET listing_type = LOWER(json_extract(raw, '$.listingType'))
       WHERE source = 'fab'
         AND sub_source = 'fab-other'
         AND listing_type IS NULL
         AND json_extract(raw, '$.listingType') IS NOT NULL
    `)
    db.exec(`
      UPDATE assets
         SET listing_type = (
           SELECT LOWER(json_extract(c.value, '$.id'))
             FROM json_each(json_extract(raw, '$.categories')) AS c
            WHERE LOWER(json_extract(c.value, '$.id')) IN (
              '3d-model','animation','audio','game-system','game-template',
              'material','tool-and-plugin','tutorials-examples','ui','vfx'
            )
            LIMIT 1
         )
       WHERE source = 'fab'
         AND sub_source = 'fab-ue'
         AND listing_type IS NULL
         AND json_extract(raw, '$.categories') IS NOT NULL
    `)
  } catch (err) {
    console.warn('[schema] listing_type backfill skipped:', err)
  }
}

/**
 * Categories migration: drop any tag we may have written under the old
 * "use raw categories[].id" strategy and re-populate `asset_tags` from the
 * `name` field instead, slugified. Tracked by `PRAGMA user_version` so it
 * only runs once per database — incremental sync maintains tags from there
 * onwards via `replaceTags()`.
 *
 * v0 → v1: categories[] derived tag set.
 */
function migrateCategoriesToSluggedNames(db: Database.Database): void {
  let v: number
  try {
    v = db.pragma('user_version', { simple: true }) as number
  } catch {
    v = 0
  }
  if (v >= 1) return
  try {
    db.exec(`DELETE FROM asset_tags WHERE source = 'fab'`)
    const rows = db
      .prepare(`SELECT source_id, raw FROM assets WHERE source = 'fab' AND raw IS NOT NULL`)
      .all() as Array<{ source_id: string; raw: string }>
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO asset_tags (source, source_id, tag) VALUES ('fab', ?, ?)`
    )
    const tx = db.transaction((items: Array<{ source_id: string; raw: string }>) => {
      for (const row of items) {
        const slugs = extractCategorySlugsFromRaw(row.raw)
        for (const slug of slugs) insertStmt.run(row.source_id, slug)
      }
    })
    tx(rows)
    db.pragma('user_version = 1')
    console.warn(
      `[schema] re-tagged ${rows.length} fab assets from raw.categories[].name (user_version → 1)`
    )
  } catch (err) {
    console.warn('[schema] categories migration skipped:', err)
  }
}

/**
 * Read a fab asset's raw JSON and return its slugified category tags. Mirrors
 * `extractFabUeCategories()` / `extractFabOtherCategories()` but works without
 * pulling in the typed parsing layer.
 */
function extractCategorySlugsFromRaw(rawJson: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return []
  }
  const obj = parsed as { categories?: unknown; tags?: unknown }
  const set = new Set<string>()
  for (const candidate of [obj.categories, obj.tags]) {
    if (!Array.isArray(candidate)) continue
    for (const entry of candidate) {
      if (typeof entry === 'string') {
        const slug = slugifyCategory(entry)
        if (slug) set.add(slug)
      } else if (entry && typeof entry === 'object') {
        const c = entry as { id?: unknown; name?: unknown }
        const id = typeof c.id === 'string' ? c.id.toLowerCase() : ''
        if (FAB_LISTING_TYPE_IDS.has(id)) continue
        if (FAB_UE_PATH_TO_LISTING_TYPE[id]) continue
        if (typeof c.name === 'string') {
          const slug = slugifyCategory(c.name)
          if (slug) set.add(slug)
        }
      }
    }
  }
  return [...set]
}

/**
 * Migration v1 → v2: re-derive `listing_type` for Fab UE rows that are still
 * NULL. The first-pass SQL backfill only matched canonical slugs in
 * `categories[].id`, but most UE assets ship path-shaped ids
 * (`Assets/animations`, …) instead. We replay the full derivation chain
 * (canonical slug → path map → distributionMethod fallback) in TS, since
 * doing it in pure SQL would need a verbose CASE WHEN ladder.
 *
 * Also rewrites tag rows whose `tag` happens to match a path/listing-type slug,
 * so previously-collected "Animations" / "Characters" tags stop showing up in
 * the Categories dropdown. Tracked by `PRAGMA user_version` so it runs once.
 */
function migrateFabUePathListingTypes(db: Database.Database): void {
  let v: number
  try {
    v = db.pragma('user_version', { simple: true }) as number
  } catch {
    v = 0
  }
  if (v >= 2) return
  try {
    const rows = db
      .prepare(
        `SELECT source_id, raw FROM assets
          WHERE source = 'fab'
            AND sub_source = 'fab-ue'
            AND listing_type IS NULL
            AND raw IS NOT NULL`
      )
      .all() as Array<{ source_id: string; raw: string }>
    const updateStmt = db.prepare(
      `UPDATE assets SET listing_type = ? WHERE source = 'fab' AND source_id = ?`
    )
    const tx = db.transaction((items: Array<{ source_id: string; raw: string }>) => {
      for (const row of items) {
        const lt = deriveListingTypeFromRaw(row.raw)
        if (lt) updateStmt.run(lt, row.source_id)
      }
    })
    tx(rows)

    // Re-derive tags so any leftover path-style entries get dropped from the
    // Categories dropdown (no-op for users whose v1 migration already filtered).
    db.exec(`DELETE FROM asset_tags WHERE source = 'fab'`)
    const allFab = db
      .prepare(`SELECT source_id, raw FROM assets WHERE source = 'fab' AND raw IS NOT NULL`)
      .all() as Array<{ source_id: string; raw: string }>
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO asset_tags (source, source_id, tag) VALUES ('fab', ?, ?)`
    )
    const tagTx = db.transaction((items: Array<{ source_id: string; raw: string }>) => {
      for (const row of items) {
        for (const slug of extractCategorySlugsFromRaw(row.raw)) {
          insertStmt.run(row.source_id, slug)
        }
      }
    })
    tagTx(allFab)

    db.pragma('user_version = 2')
    console.warn(
      `[schema] migrated ${rows.length} fab-ue listing_type values and re-tagged ${allFab.length} assets (user_version → 2)`
    )
  } catch (err) {
    console.warn('[schema] listing_type/categories v2 migration skipped:', err)
  }
}

/** TS-side mirror of `deriveFabUeListingType` from `normalize.ts`. */
function deriveListingTypeFromRaw(rawJson: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return null
  }
  const obj = parsed as {
    categories?: Array<{ id?: unknown }>
    distributionMethod?: unknown
  }
  if (Array.isArray(obj.categories)) {
    for (const cat of obj.categories) {
      const id = typeof cat?.id === 'string' ? cat.id.toLowerCase() : ''
      if (FAB_LISTING_TYPE_IDS.has(id)) return id
    }
    for (const cat of obj.categories) {
      const id = typeof cat?.id === 'string' ? cat.id.toLowerCase() : ''
      const mapped = FAB_UE_PATH_TO_LISTING_TYPE[id]
      if (mapped) return mapped
    }
  }
  const dm = typeof obj.distributionMethod === 'string' ? obj.distributionMethod.toUpperCase() : ''
  return FAB_DISTRIBUTION_TO_LISTING_TYPE[dm] ?? null
}

/**
 * Migration v2 → v3: populate `assets.seller` for rows that pre-date the
 * column. The display-name lives in three different shapes depending on the
 * source: `raw.seller` (Fab UE), `raw.publisher.sellerName` (Fab Other),
 * `raw.catalog.developer` (Epic Vault). Pure-SQL with `json_extract` so we
 * don't need to parse every blob in JS; runs once and tracks via
 * `PRAGMA user_version`.
 */
function backfillSeller(db: Database.Database): void {
  let v: number
  try {
    v = db.pragma('user_version', { simple: true }) as number
  } catch {
    v = 0
  }
  if (v >= 3) return
  try {
    const fabUe = db
      .prepare(
        `UPDATE assets
            SET seller = NULLIF(TRIM(json_extract(raw, '$.seller')), '')
          WHERE source = 'fab'
            AND sub_source = 'fab-ue'
            AND seller IS NULL
            AND raw IS NOT NULL`
      )
      .run()
    const fabOther = db
      .prepare(
        `UPDATE assets
            SET seller = NULLIF(TRIM(json_extract(raw, '$.publisher.sellerName')), '')
          WHERE source = 'fab'
            AND sub_source = 'fab-other'
            AND seller IS NULL
            AND raw IS NOT NULL`
      )
      .run()
    const vault = db
      .prepare(
        `UPDATE assets
            SET seller = NULLIF(TRIM(json_extract(raw, '$.catalog.developer')), '')
          WHERE source = 'vault'
            AND seller IS NULL
            AND raw IS NOT NULL`
      )
      .run()
    db.pragma('user_version = 3')
    console.warn(
      `[schema] backfilled seller for ${fabUe.changes} fab-ue, ${fabOther.changes} fab-other, ${vault.changes} vault rows (user_version → 3)`
    )
  } catch (err) {
    console.warn('[schema] seller backfill skipped:', err)
  }
}

/**
 * Migration v4 → v5: Fab library filters. Backfills `fab_listing_uid` and
 * `engine_versions` on existing fab-ue rows from `raw` with the same helpers
 * `normalizeFabAsset` uses, and deletes the Fab "Other" rows, which ReHoarder
 * no longer syncs. Their tags are deleted explicitly because `foreign_keys`
 * may be off on this connection.
 */
function migrateFabLibraryFilters(db: Database.Database): void {
  let v: number
  try {
    v = db.pragma('user_version', { simple: true }) as number
  } catch {
    v = 0
  }
  if (v >= 5) return
  try {
    const tx = db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT account_id, source_id, raw FROM assets
            WHERE source = 'fab' AND sub_source = 'fab-ue' AND raw IS NOT NULL`
        )
        .all() as Array<{ account_id: string; source_id: string; raw: string }>
      const update = db.prepare(
        `UPDATE assets SET fab_listing_uid = ?, engine_versions = ?
          WHERE account_id = ? AND source = 'fab' AND source_id = ?`
      )
      let backfilled = 0
      for (const r of rows) {
        let parsed: unknown
        try {
          parsed = JSON.parse(r.raw)
        } catch {
          continue
        }
        if (!parsed || typeof parsed !== 'object') continue
        const item = parsed as Record<string, unknown>
        update.run(
          fabListingUidFromItem(item),
          toJsonArrayOrNull(engineVersionsFromItem(item)),
          r.account_id,
          r.source_id
        )
        backfilled += 1
      }
      db.prepare(
        `DELETE FROM asset_tags
          WHERE (account_id, source, source_id) IN (
            SELECT account_id, source, source_id FROM assets WHERE sub_source = 'fab-other'
          )`
      ).run()
      const deleted = db.prepare(`DELETE FROM assets WHERE sub_source = 'fab-other'`).run()
      return { backfilled, deleted: deleted.changes }
    })
    const { backfilled, deleted } = tx()
    db.pragma('user_version = 5')
    console.warn(
      `[schema] backfilled filter columns on ${backfilled} fab-ue rows, deleted ${deleted} fab-other rows (user_version → 5)`
    )
  } catch (err) {
    console.warn('[schema] fab library filters migration skipped:', err)
  }
}

function tryAddColumn(
  db: Database.Database,
  table: string,
  column: string,
  type: string
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.toLowerCase().includes('duplicate column name')) return
    if (msg.toLowerCase().includes('no such table')) return
    throw err
  }
}

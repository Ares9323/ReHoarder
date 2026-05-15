import type Database from 'better-sqlite3'
import {
  FAB_DISTRIBUTION_TO_LISTING_TYPE,
  FAB_LISTING_TYPE_IDS,
  FAB_UE_PATH_TO_LISTING_TYPE,
  slugifyCategory
} from '../category-slug'

export function applySchema(db: Database.Database): void {
  // Order matters: create the base tables FIRST, then run migrations on top.
  // `tryAddColumn` silently no-ops "no such table" errors, so on a fresh DB
  // with the previous ordering the migrations would have skipped — leaving
  // `bookmarked` / `sub_source` / `listing_type` / `seller` missing until
  // the next launch. Creating first then migrating means a single launch
  // converges to the full schema for both fresh installs and upgrades.
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
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
      PRIMARY KEY (source, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_assets_hidden ON assets (hidden);
    CREATE INDEX IF NOT EXISTS idx_assets_source ON assets (source);

    CREATE TABLE IF NOT EXISTS asset_tags (
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (source, source_id, tag),
      FOREIGN KEY (source, source_id) REFERENCES assets(source, source_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags (tag);

    CREATE TABLE IF NOT EXISTS sync_state (
      source TEXT PRIMARY KEY,
      last_sync_at INTEGER,
      last_sync_status TEXT,
      last_sync_error TEXT
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
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
  backfillFabSubSource(db)
  backfillListingType(db)
  migrateCategoriesToSluggedNames(db)
  migrateFabUePathListingTypes(db)
  backfillSeller(db)
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

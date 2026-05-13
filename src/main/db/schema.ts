import type Database from 'better-sqlite3'

export function applySchema(db: Database.Database): void {
  applyMigrations(db)
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
  backfillFabSubSource(db)
  backfillListingType(db)
  backfillCategories(db)
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
 * Backfill `asset_tags` from `assets.raw.categories[].id` for every Fab row.
 *
 * Skipped on re-runs: if `asset_tags` already contains any `fab`-sourced row
 * we assume the backfill ran in a previous startup. New sync runs maintain
 * tags incrementally via `replaceTags()` per asset, so this only needs to
 * fire once after migrating to the categories-aware schema.
 */
function backfillCategories(db: Database.Database): void {
  try {
    const existing = db
      .prepare(`SELECT COUNT(*) AS n FROM asset_tags WHERE source = 'fab'`)
      .get() as { n: number }
    if (existing.n > 0) return
    db.exec(`
      INSERT OR IGNORE INTO asset_tags (source, source_id, tag)
      SELECT a.source,
             a.source_id,
             LOWER(json_extract(c.value, '$.id'))
        FROM assets AS a, json_each(json_extract(a.raw, '$.categories')) AS c
       WHERE a.source = 'fab'
         AND json_extract(a.raw, '$.categories') IS NOT NULL
         AND json_extract(c.value, '$.id') IS NOT NULL
    `)
  } catch (err) {
    console.warn('[schema] categories backfill skipped:', err)
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

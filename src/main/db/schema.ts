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
  backfillFabSubSource(db)
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

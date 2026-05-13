import type Database from 'better-sqlite3'

export function applySchema(db: Database.Database): void {
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
  `)
}

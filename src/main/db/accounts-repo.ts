import type Database from 'better-sqlite3'
import type { KvStore } from './kv'
import { LEGACY_ACCOUNT_ID } from './schema'

/** Row shape exposed to the rest of the app. `createdAt`/`lastUsedAt` are ms epochs. */
export interface AccountRow {
  id: string
  displayName: string
  createdAt: number
  lastUsedAt: number
}

interface AccountRowDb {
  id: string
  display_name: string
  created_at: number
  last_used_at: number
}

function fromDb(r: AccountRowDb): AccountRow {
  return {
    id: r.id,
    displayName: r.display_name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at
  }
}

/** kv key that holds the currently active account id (or absent → no active). */
const KEY_ACTIVE_ACCOUNT_ID = 'accounts.active_id'

/**
 * Tracks every Epic account ReHoarder has tokens for, plus a single "active"
 * pointer. Other repos (assets, downloads, sync_state) bind their queries to
 * `getActiveId()` to scope rows to the right account.
 *
 * The `'legacy'` row is a placeholder for pre-multi-account data: it lives
 * until the first successful login post-migration, at which point
 * `rebindLegacyTo(realId)` rewrites every `account_id = 'legacy'` row to the
 * real Epic account id and drops the placeholder.
 */
export class AccountsRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly kv: KvStore
  ) {}

  list(): AccountRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, display_name, created_at, last_used_at
           FROM accounts
          WHERE id != ?
          ORDER BY last_used_at DESC`
      )
      .all(LEGACY_ACCOUNT_ID) as AccountRowDb[]
    return rows.map(fromDb)
  }

  findById(id: string): AccountRow | null {
    const row = this.db
      .prepare(
        `SELECT id, display_name, created_at, last_used_at FROM accounts WHERE id = ?`
      )
      .get(id) as AccountRowDb | undefined
    return row ? fromDb(row) : null
  }

  /** Insert or update. Refreshes `last_used_at` whenever called. */
  upsert(id: string, displayName: string): AccountRow {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO accounts (id, display_name, created_at, last_used_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           last_used_at = excluded.last_used_at`
      )
      .run(id, displayName, now, now)
    return this.findById(id)!
  }

  /** Remove the account row only. Per-account data in assets/downloads/etc
   *  must be wiped by the caller via `wipeAccountData()`. */
  remove(id: string): void {
    this.db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id)
    if (this.getActiveId() === id) {
      this.kv.delete(KEY_ACTIVE_ACCOUNT_ID)
    }
  }

  /** Wipe every per-account row across the four scoped tables. Used when an
   *  account is signed out / removed. The `accounts` row itself is left
   *  alone — call `remove()` for that. */
  wipeAccountData(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM assets WHERE account_id = ?`).run(id)
      this.db.prepare(`DELETE FROM asset_tags WHERE account_id = ?`).run(id)
      this.db.prepare(`DELETE FROM sync_state WHERE account_id = ?`).run(id)
      this.db.prepare(`DELETE FROM downloads WHERE account_id = ?`).run(id)
    })
    tx()
  }

  getActiveId(): string | null {
    return this.kv.get(KEY_ACTIVE_ACCOUNT_ID)
  }

  setActiveId(id: string | null): void {
    if (id === null) {
      this.kv.delete(KEY_ACTIVE_ACCOUNT_ID)
      return
    }
    this.kv.set(KEY_ACTIVE_ACCOUNT_ID, id)
    // Touch last_used_at so the list ordering reflects the switch.
    this.db.prepare(`UPDATE accounts SET last_used_at = ? WHERE id = ?`).run(Date.now(), id)
  }

  /**
   * Rewrite every `account_id = 'legacy'` row across the scoped tables to
   * `newId`. Also drops the `'legacy'` placeholder row from `accounts`. Used
   * the first time we know the real Epic account id for the data persisted
   * before multi-account existed. Returns the number of rows touched (asset
   * rows only; the rest are tracked silently).
   */
  rebindLegacyTo(newId: string, displayName: string): number {
    if (newId === LEGACY_ACCOUNT_ID) return 0
    const tx = this.db.transaction(() => {
      // Make sure the destination account row exists before we move data
      // under it — otherwise the post-rebind queries would find data but no
      // matching account record.
      this.upsert(newId, displayName)
      // Avoid PK collisions on the rebind: if the new account already has
      // some rows with the same (source, source_id), the legacy ones lose.
      // `INSERT OR IGNORE` semantics via UPDATE OR IGNORE on the rewrite.
      const assetsChanged = this.db
        .prepare(
          `UPDATE OR IGNORE assets SET account_id = ? WHERE account_id = ?`
        )
        .run(newId, LEGACY_ACCOUNT_ID).changes ?? 0
      this.db
        .prepare(`DELETE FROM assets WHERE account_id = ?`)
        .run(LEGACY_ACCOUNT_ID)
      this.db
        .prepare(`UPDATE OR IGNORE asset_tags SET account_id = ? WHERE account_id = ?`)
        .run(newId, LEGACY_ACCOUNT_ID)
      this.db
        .prepare(`DELETE FROM asset_tags WHERE account_id = ?`)
        .run(LEGACY_ACCOUNT_ID)
      this.db
        .prepare(`UPDATE OR IGNORE sync_state SET account_id = ? WHERE account_id = ?`)
        .run(newId, LEGACY_ACCOUNT_ID)
      this.db
        .prepare(`DELETE FROM sync_state WHERE account_id = ?`)
        .run(LEGACY_ACCOUNT_ID)
      this.db
        .prepare(`UPDATE downloads SET account_id = ? WHERE account_id = ?`)
        .run(newId, LEGACY_ACCOUNT_ID)
      this.db.prepare(`DELETE FROM accounts WHERE id = ?`).run(LEGACY_ACCOUNT_ID)
      return assetsChanged
    })
    return tx() as number
  }

  /** True iff the placeholder row from the v3 → v4 migration is still around. */
  hasLegacyRow(): boolean {
    const r = this.db
      .prepare(`SELECT 1 FROM accounts WHERE id = ?`)
      .get(LEGACY_ACCOUNT_ID) as { 1: number } | undefined
    return r !== undefined
  }
}

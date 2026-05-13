import type Database from 'better-sqlite3'

export class KvStore {
  private readonly getStmt: Database.Statement
  private readonly setStmt: Database.Statement
  private readonly deleteStmt: Database.Statement
  private readonly keysStmt: Database.Statement

  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    this.getStmt = db.prepare('SELECT value FROM kv WHERE key = ?')
    this.setStmt = db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    this.deleteStmt = db.prepare('DELETE FROM kv WHERE key = ?')
    this.keysStmt = db.prepare('SELECT key FROM kv')
  }

  get(key: string): string | null {
    const row = this.getStmt.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.setStmt.run(key, value)
  }

  delete(key: string): void {
    this.deleteStmt.run(key)
  }

  keys(): string[] {
    return (this.keysStmt.all() as { key: string }[]).map((r) => r.key)
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value))
  }

  getJson<T = unknown>(key: string): T | null {
    const raw = this.get(key)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }
}

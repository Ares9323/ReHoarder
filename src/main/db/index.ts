import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { KvStore } from './kv'
import { applySchema } from './schema'

export interface AppDb {
  raw: Database.Database
  kv: KvStore
}

export function openAppDb(): AppDb {
  const userDataDir = app.getPath('userData')
  mkdirSync(userDataDir, { recursive: true })
  const dbPath = join(userDataDir, 'rehoarder.db')
  const raw = new Database(dbPath)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  const kv = new KvStore(raw)
  applySchema(raw)
  return { raw, kv }
}

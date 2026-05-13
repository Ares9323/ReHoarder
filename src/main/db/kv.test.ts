import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { KvStore } from './kv'

let db: Database.Database
let kv: KvStore

beforeEach(() => {
  db = new Database(':memory:')
  kv = new KvStore(db)
})

describe('KvStore', () => {
  it('returns null for unknown key', () => {
    expect(kv.get('missing')).toBeNull()
  })

  it('stores and retrieves a string value', () => {
    kv.set('name', 'rehoarder')
    expect(kv.get('name')).toBe('rehoarder')
  })

  it('overwrites an existing key', () => {
    kv.set('name', 'first')
    kv.set('name', 'second')
    expect(kv.get('name')).toBe('second')
  })

  it('serializes and deserializes objects via JSON', () => {
    const value = { id: 42, label: 'asset' }
    kv.setJson('config', value)
    expect(kv.getJson<typeof value>('config')).toEqual(value)
  })

  it('returns null when JSON parse fails on stored garbage', () => {
    kv.set('garbage', 'not valid json {{')
    expect(kv.getJson('garbage')).toBeNull()
  })

  it('deletes a key', () => {
    kv.set('toRemove', 'x')
    kv.delete('toRemove')
    expect(kv.get('toRemove')).toBeNull()
  })

  it('lists all stored keys', () => {
    kv.set('a', '1')
    kv.set('b', '2')
    expect(kv.keys().sort()).toEqual(['a', 'b'])
  })
})

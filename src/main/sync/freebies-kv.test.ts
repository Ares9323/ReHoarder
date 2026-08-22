import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { KvStore } from '../db/kv'
import {
  claimedUidsKey,
  lastSeenUidsKey,
  lastAutoSyncAtKey,
  readUidSet,
  writeUidSet,
  readTimestamp,
  writeTimestamp
} from './freebies-kv'

let db: Database.Database
let kv: KvStore

beforeEach(() => {
  db = new Database(':memory:')
  kv = new KvStore(db)
})

describe('freebies per-account key names', () => {
  it('suffixes each key with the account id', () => {
    expect(claimedUidsKey('acct-1')).toBe('freebies.claimedUids.acct-1')
    expect(lastSeenUidsKey('acct-1')).toBe('freebies.lastSeenUids.acct-1')
    expect(lastAutoSyncAtKey('acct-1')).toBe('freebies.lastAutoSyncAt.acct-1')
  })
})

describe('readUidSet / writeUidSet', () => {
  it('returns an empty set for a missing key', () => {
    expect(readUidSet(kv, claimedUidsKey('a')).size).toBe(0)
  })

  it('round-trips a set of uids', () => {
    writeUidSet(kv, claimedUidsKey('a'), ['x', 'y', 'x'])
    const set = readUidSet(kv, claimedUidsKey('a'))
    expect([...set].sort()).toEqual(['x', 'y'])
  })

  it('treats malformed JSON as an empty set', () => {
    kv.set(claimedUidsKey('a'), 'not json {{')
    expect(readUidSet(kv, claimedUidsKey('a')).size).toBe(0)
  })

  it('treats a non-array JSON value as an empty set', () => {
    kv.set(claimedUidsKey('a'), '{"nope":1}')
    expect(readUidSet(kv, claimedUidsKey('a')).size).toBe(0)
  })

  it('ignores non-string array members', () => {
    kv.set(claimedUidsKey('a'), '["ok", 1, null, "two"]')
    expect([...readUidSet(kv, claimedUidsKey('a'))].sort()).toEqual(['ok', 'two'])
  })

  it('keeps sets isolated per account key', () => {
    writeUidSet(kv, claimedUidsKey('a'), ['a1'])
    writeUidSet(kv, claimedUidsKey('b'), ['b1'])
    expect([...readUidSet(kv, claimedUidsKey('a'))]).toEqual(['a1'])
    expect([...readUidSet(kv, claimedUidsKey('b'))]).toEqual(['b1'])
  })
})

describe('readTimestamp / writeTimestamp', () => {
  it('returns null for a missing key', () => {
    expect(readTimestamp(kv, lastAutoSyncAtKey('a'))).toBeNull()
  })

  it('round-trips a numeric timestamp', () => {
    writeTimestamp(kv, lastAutoSyncAtKey('a'), 1_700_000_000_000)
    expect(readTimestamp(kv, lastAutoSyncAtKey('a'))).toBe(1_700_000_000_000)
  })

  it('returns null for a non-numeric stored value', () => {
    kv.set(lastAutoSyncAtKey('a'), 'abc')
    expect(readTimestamp(kv, lastAutoSyncAtKey('a'))).toBeNull()
  })
})

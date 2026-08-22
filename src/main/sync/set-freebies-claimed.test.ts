import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { KvStore } from '../db/kv'
import { setClaimedInKv } from './set-freebies-claimed'
import { claimedUidsKey, readUidSet } from './freebies-kv'

let db: Database.Database
let kv: KvStore

beforeEach(() => {
  db = new Database(':memory:')
  kv = new KvStore(db)
})

describe('setClaimedInKv', () => {
  it('adds uids when claimed is true', () => {
    const updated = setClaimedInKv(kv, 'acct', ['A', 'B'], true)
    expect(updated.sort()).toEqual(['A', 'B'])
    expect([...readUidSet(kv, claimedUidsKey('acct'))].sort()).toEqual(['A', 'B'])
  })

  it('removes uids when claimed is false', () => {
    setClaimedInKv(kv, 'acct', ['A', 'B'], true)
    const updated = setClaimedInKv(kv, 'acct', ['A'], false)
    expect(updated).toEqual(['B'])
    expect([...readUidSet(kv, claimedUidsKey('acct'))]).toEqual(['B'])
  })

  it('round-trips add then remove of the same uid', () => {
    setClaimedInKv(kv, 'acct', ['X'], true)
    const updated = setClaimedInKv(kv, 'acct', ['X'], false)
    expect(updated).toEqual([])
  })

  it('mark-all sets every passed uid', () => {
    const updated = setClaimedInKv(kv, 'acct', ['A', 'B', 'C'], true)
    expect(updated.sort()).toEqual(['A', 'B', 'C'])
  })

  it('is isolated per account', () => {
    setClaimedInKv(kv, 'acct-1', ['A'], true)
    setClaimedInKv(kv, 'acct-2', ['B'], true)
    expect([...readUidSet(kv, claimedUidsKey('acct-1'))]).toEqual(['A'])
    expect([...readUidSet(kv, claimedUidsKey('acct-2'))]).toEqual(['B'])
  })
})

import type { KvStore } from '../db/kv'

/**
 * KV key names for the freebies feature, scoped per active Epic/Fab account.
 * Every freebies key carries the `.<accountId>` suffix so a different account
 * (which sees a different free set) never bleeds its claimed / last-seen state
 * into another.
 */
export function claimedUidsKey(accountId: string): string {
  return `freebies.claimedUids.${accountId}`
}

export function lastSeenUidsKey(accountId: string): string {
  return `freebies.lastSeenUids.${accountId}`
}

export function lastAutoSyncAtKey(accountId: string): string {
  return `freebies.lastAutoSyncAt.${accountId}`
}

/**
 * Read a JSON string-array KV value as a Set. Missing key, malformed JSON, a
 * non-array value, and non-string members are all tolerated: the result is
 * simply the empty (or filtered) set. Never throws.
 */
export function readUidSet(kv: KvStore, key: string): Set<string> {
  const raw = kv.get(key)
  if (raw === null) return new Set()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

/** Write a set/iterable of uids as a JSON string array. */
export function writeUidSet(kv: KvStore, key: string, uids: Iterable<string>): void {
  kv.set(key, JSON.stringify([...new Set(uids)]))
}

/** Read a numeric-timestamp KV value; null when missing or non-numeric. */
export function readTimestamp(kv: KvStore, key: string): number | null {
  const raw = kv.get(key)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Write a numeric timestamp. */
export function writeTimestamp(kv: KvStore, key: string, ms: number): void {
  kv.set(key, String(ms))
}

import type { KvStore } from '../db/kv'
import { claimedUidsKey, readUidSet, writeUidSet } from './freebies-kv'

/**
 * Add or remove `uids` from the account's manual claimed set in KV and return
 * the updated set as a sorted array. `claimed === true` adds, `false` removes.
 */
export function setClaimedInKv(
  kv: KvStore,
  accountId: string,
  uids: string[],
  claimed: boolean
): string[] {
  const key = claimedUidsKey(accountId)
  const set = readUidSet(kv, key)
  for (const uid of uids) {
    if (claimed) set.add(uid)
    else set.delete(uid)
  }
  writeUidSet(kv, key, set)
  return [...set].sort()
}

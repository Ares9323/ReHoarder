import type { FabFreebie } from '../fab/fab-freebies'

/**
 * Stamp each freebie's `claimed` flag from the active account's manual set.
 * Claimed is manual-only: `claimed = claimedUids.has(f.uid)`; nothing else
 * writes it. Mutates in place.
 */
export function applyClaimedFlags(freebies: FabFreebie[], claimedUids: Set<string>): void {
  for (const f of freebies) {
    f.claimed = claimedUids.has(f.uid)
  }
}

/** Count freebies the user has NOT marked claimed. */
export function countUnclaimed(freebies: FabFreebie[]): number {
  return freebies.filter((f) => f.claimed !== true).length
}

const SEVEN_DAYS_MS = 7 * 86_400_000

/**
 * The weekly cap gate. `withinCap` is true when a check ran less than 7 days
 * ago, in which case the background probe skips the network entirely. A missing
 * `lastAutoSyncAt` (first check for this account) is never within cap.
 */
export function decideAutoCheck(args: {
  lastAutoSyncAt: number | null
  now: number
}): { withinCap: boolean } {
  if (args.lastAutoSyncAt === null) return { withinCap: false }
  return { withinCap: args.now - args.lastAutoSyncAt < SEVEN_DAYS_MS }
}

/** Current uids that were not in the last-seen set (a "new drop"). */
export function diffNewUids(currentUids: string[], lastSeen: Set<string>): string[] {
  return currentUids.filter((u) => !lastSeen.has(u))
}

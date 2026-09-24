/** Mirrors `FabWebStatus` in the preload types. */
export type FabWebStatus = 'logged-in' | 'logged-out' | 'unknown'

export interface FabWebChipState {
  label: string
  /** True when clicking starts the "Sign in to Fab" flow. */
  clickable: boolean
  /** Drawn with the accent style: the last sync skipped entitlements. */
  highlight: boolean
}

/**
 * Assets header chip next to "Sync now". `status` is null before the first
 * check; `attention` is set after a sync that found fab.com logged out.
 */
export function fabWebChip(
  status: FabWebStatus | null,
  busy: boolean,
  attention: boolean
): FabWebChipState {
  if (busy) return { label: 'Fab: signing in…', clickable: false, highlight: false }
  if (status === null) return { label: 'Fab: checking…', clickable: false, highlight: false }
  if (status === 'logged-in') return { label: 'Fab: signed in', clickable: false, highlight: false }
  return { label: 'Fab: sign in', clickable: true, highlight: attention }
}

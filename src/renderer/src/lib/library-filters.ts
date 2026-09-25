/** Sort and filter vocabulary for the Assets tab, mirroring fab.com/library. */

export type AssetSort = 'newest' | 'oldest' | 'title-asc' | 'title-desc' | 'last-updated'

export const SORT_OPTIONS: ReadonlyArray<{ value: AssetSort; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title-asc', label: 'Title A-Z' },
  { value: 'title-desc', label: 'Title Z-A' },
  { value: 'last-updated', label: 'Last Updated' }
]

export const DEFAULT_SORT: AssetSort = 'title-asc'

/** Validate a persisted sort value; anything unknown becomes the default. */
export function parseSort(raw: string | null): AssetSort {
  return SORT_OPTIONS.some((o) => o.value === raw) ? (raw as AssetSort) : DEFAULT_SORT
}

export type AddedSince = '' | '24h' | '7d' | '30d' | '6m' | '12m'

export const ADDED_SINCE_OPTIONS: ReadonlyArray<{ value: AddedSince; label: string }> = [
  { value: '', label: 'Added: all time' },
  { value: '24h', label: 'Past 24 hours' },
  { value: '7d', label: 'Past 7 days' },
  { value: '30d', label: 'Past 30 days' },
  { value: '6m', label: 'Past 6 months' },
  { value: '12m', label: 'Past 12 months' }
]

const DAY_MS = 24 * 60 * 60 * 1000
const ADDED_SINCE_DAYS: Record<Exclude<AddedSince, ''>, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '6m': 182,
  '12m': 365
}

/** Lower bound (epoch ms) for the `ownedSince` query field; undefined means no bound. */
export function addedSinceToTimestamp(v: AddedSince, now: number): number | undefined {
  if (v === '') return undefined
  return now - ADDED_SINCE_DAYS[v] * DAY_MS
}

const LICENSE_LABELS: Record<string, string> = {
  personal: 'Personal',
  professional: 'Professional',
  'legacy-uem': 'UE Marketplace License',
  'cc-by': 'CC-BY',
  'uefn-reference-only': 'UEFN (reference only)'
}

/** Fab display name for a license slug, or the slug itself when unknown. */
export function licenseLabel(slug: string): string {
  return LICENSE_LABELS[slug] ?? slug
}

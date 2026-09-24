/**
 * Pure helpers that derive the filterable columns of a Fab UE library row
 * (`fab_listing_uid`, `engine_versions`) and parse entitlement fields.
 * Shared by `normalizeFabAsset` (live sync) and the v5 schema backfill so
 * both paths produce identical values.
 */

export interface ListingFieldsSource {
  customAttributes?: unknown
  url?: unknown
  projectVersions?: unknown
}

/** Fab listing uid: `customAttributes[].ListingIdentifier` first, else the last path segment of `url`. */
export function fabListingUidFromItem(item: ListingFieldsSource): string | null {
  if (Array.isArray(item.customAttributes)) {
    for (const attr of item.customAttributes) {
      const id = (attr as { ListingIdentifier?: unknown } | null)?.ListingIdentifier
      if (typeof id === 'string' && id.length > 0) return id
    }
  }
  if (typeof item.url === 'string') {
    const tail = item.url
      .split('/')
      .filter((s) => s.length > 0)
      .pop()
    if (tail) return tail
  }
  return null
}

/** Deduped `major.minor` engine versions (`UE_5.4` becomes `5.4`), newest first. */
export function engineVersionsFromItem(item: ListingFieldsSource): string[] {
  const set = new Set<string>()
  if (Array.isArray(item.projectVersions)) {
    for (const pv of item.projectVersions) {
      const versions = (pv as { engineVersions?: unknown } | null)?.engineVersions
      if (!Array.isArray(versions)) continue
      for (const v of versions) {
        if (typeof v !== 'string') continue
        const clean = v.replace(/^UE_/i, '').trim()
        if (clean) set.add(clean)
      }
    }
  }
  return [...set].sort(compareEngineVersionsDesc)
}

/** Numeric comparator, newest first: `5.10` sorts before `5.9`. */
export function compareEngineVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0
    const y = Number.isFinite(pb[i]) ? pb[i] : 0
    if (x !== y) return y - x
  }
  return 0
}

/** ISO timestamp to epoch ms, or null. Fab sends microseconds, trimmed to ms first. */
export function parseFabTimestamp(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const ms = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isFinite(ms) ? ms : null
}

/** Column encoding for `licenses` / `engine_versions`: JSON array, or NULL when empty. */
export function toJsonArrayOrNull(values: string[]): string | null {
  return values.length > 0 ? JSON.stringify(values) : null
}

/** Inverse of `toJsonArrayOrNull`, tolerant of NULL and malformed values. */
export function parseJsonStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

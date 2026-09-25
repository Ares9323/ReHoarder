import type { AssetRow, FabEntitlementInfo } from '../db/assets-repo'
import type { CatalogItem, VaultAssetSummary } from '../vault/vault-client'
import type { FabEntitlementResult, FabLibraryItem } from '../fab/fab-client'
import {
  engineVersionsFromItem,
  fabListingUidFromItem,
  parseFabTimestamp
} from '../fab/fab-listing-fields'
import {
  FAB_DISTRIBUTION_TO_LISTING_TYPE,
  FAB_LISTING_TYPE_IDS,
  FAB_UE_PATH_TO_LISTING_TYPE,
  slugifyCategory
} from '../category-slug'

export function normalizeVaultAsset(
  summary: VaultAssetSummary,
  catalog: CatalogItem,
  syncedAt: number
): AssetRow {
  const title = catalog.title ?? summary.appName
  const description = catalog.description ?? catalog.longDescription ?? null
  const imageUrl = pickThumbnailUrl(catalog.keyImages) ?? null
  const ownedAt = catalog.creationDate ? Date.parse(catalog.creationDate) : null

  return {
    source: 'vault',
    sourceId: summary.catalogItemId,
    subSource: null,
    listingType: null,
    title,
    description,
    imageUrl,
    productUrl: null,
    ownedAt: ownedAt !== null && Number.isFinite(ownedAt) ? ownedAt : null,
    hidden: false,
    bookmarked: false,
    seller: pickString((catalog as { developer?: unknown }).developer),
    raw: JSON.stringify({ summary, catalog }),
    syncedAt,
    lastPreciseAt: null
  }
}

/** Trim + return a string only if it has non-whitespace content. Used by the
 *  seller-extraction paths where the upstream payload is typed `unknown`
 *  (catalog/publisher shapes vary across endpoints). */
function pickString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

function deriveFabUeListingType(item: FabLibraryItem): string | null {
  if (item.categories) {
    // First pass: direct canonical slug (rare in UE — only CODE_PLUGIN-style assets).
    for (const cat of item.categories) {
      const id = (cat.id ?? '').toLowerCase()
      if (FAB_LISTING_TYPE_IDS.has(id)) return id
    }
    // Second pass: UE path-shaped ids (`Assets/animations` → `animation`, …).
    for (const cat of item.categories) {
      const id = (cat.id ?? '').toLowerCase()
      const mapped = FAB_UE_PATH_TO_LISTING_TYPE[id]
      if (mapped) return mapped
    }
  }
  // Third pass: distributionMethod fallback (CODE_PLUGIN ⇒ tool-and-plugin, etc.).
  const dm = (item.distributionMethod ?? '').toUpperCase()
  return FAB_DISTRIBUTION_TO_LISTING_TYPE[dm] ?? null
}

/**
 * Slugified category names for an UE listing. We deliberately use `name`
 * rather than `id`: Fab's `id` is sometimes a slug, sometimes a path like
 * `Assets/2d`, sometimes a raw GUID. The user-facing display name (`name`)
 * is the only field that's always human-readable. Entries whose `id` matches
 * a canonical listing-type slug are skipped — they belong to the dedicated
 * listing-type column, not to the Categories dropdown.
 */
export function extractFabUeCategories(item: FabLibraryItem): string[] {
  if (!item.categories) return []
  const set = new Set<string>()
  for (const cat of item.categories) {
    const id = (cat.id ?? '').toLowerCase()
    if (FAB_LISTING_TYPE_IDS.has(id)) continue
    // Skip UE path-style entries too — they're folded into listing_type, not the
    // user-facing Categories dropdown (otherwise "Animations" would duplicate
    // the `animation` listing-type filter).
    if (FAB_UE_PATH_TO_LISTING_TYPE[id]) continue
    const name = cat.name ?? ''
    const slug = slugifyCategory(name)
    if (slug) set.add(slug)
  }
  return [...set]
}

export function normalizeFabAsset(item: FabLibraryItem, syncedAt: number): AssetRow {
  return {
    source: 'fab',
    sourceId: item.assetId,
    subSource: 'fab-ue',
    listingType: deriveFabUeListingType(item),
    title: item.title,
    description: item.description ?? null,
    imageUrl: pickFabImageUrl(item) ?? null,
    productUrl: deriveFabProductUrl(item),
    // Acquisition time is not in this payload; the entitlements pass fills it
    // in afterwards (`AssetsRepo.applyFabEntitlements`).
    ownedAt: null,
    hidden: false,
    bookmarked: false,
    seller: pickString((item as { seller?: unknown }).seller),
    raw: JSON.stringify(item),
    syncedAt,
    lastPreciseAt: null,
    fabListingUid: fabListingUidFromItem(item),
    engineVersions: engineVersionsFromItem(item)
  }
}

function pickFabImageUrl(item: FabLibraryItem): string | undefined {
  if (!item.images || item.images.length === 0) return undefined
  return item.images[0]?.url
}

// Marketplace listing URL built from the Fab listing uid (see fabListingUidFromItem).
function deriveFabProductUrl(item: FabLibraryItem): string | null {
  const uid = fabListingUidFromItem(item)
  return uid ? `https://www.fab.com/listings/${uid}` : null
}

function pickThumbnailUrl(images: CatalogItem['keyImages']): string | undefined {
  if (!images || images.length === 0) return undefined
  const thumb = images.find((img) => img.type === 'Thumbnail')
  return (thumb ?? images[0]).url
}

/**
 * Map one entitlements result to the columns the Assets filters use, keyed
 * by the Fab listing uid (the join key with the UE library rows). Null when
 * the result carries no listing uid.
 */
export function normalizeFabEntitlement(
  r: FabEntitlementResult
): { listingUid: string; info: FabEntitlementInfo } | null {
  const listingUid = r.listing?.uid
  if (typeof listingUid !== 'string' || listingUid.length === 0) return null
  const licenses = new Set<string>()
  for (const l of r.entitlement?.licenses ?? []) {
    if (typeof l?.slug === 'string' && l.slug.length > 0) licenses.add(l.slug)
  }
  return {
    listingUid,
    info: {
      ownedAt: parseFabTimestamp(r.createdAt),
      lastUpdatedAt: parseFabTimestamp(r.listing?.lastUpdatedAt),
      licenses: [...licenses].sort()
    }
  }
}

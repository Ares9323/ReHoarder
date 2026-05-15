import type { AssetRow } from '../db/assets-repo'
import type { CatalogItem, VaultAssetSummary } from '../vault/vault-client'
import type { FabLibraryItem, FabOtherListing } from '../fab/fab-client'
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
    syncedAt
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

/**
 * Best-effort extraction for Fab Other listings. The exact field name is not
 * statically typed in `FabOtherListing` (the API ships an open shape), so we
 * probe a couple of likely paths. Names are slugified to match UE assets.
 */
export function extractFabOtherCategories(listing: FabOtherListing): string[] {
  const candidates = [
    (listing as { categories?: unknown }).categories,
    (listing as { tags?: unknown }).tags
  ]
  const set = new Set<string>()
  for (const raw of candidates) {
    if (!Array.isArray(raw)) continue
    for (const entry of raw) {
      if (typeof entry === 'string') {
        const slug = slugifyCategory(entry)
        if (slug) set.add(slug)
      } else if (entry && typeof entry === 'object') {
        const obj = entry as { name?: unknown }
        if (typeof obj.name === 'string') {
          const slug = slugifyCategory(obj.name)
          if (slug) set.add(slug)
        }
      }
    }
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
    // The Fab library payload does not carry an acquisition timestamp.
    // We keep `ownedAt` null and rely on `syncedAt` for ordering.
    ownedAt: null,
    hidden: false,
    bookmarked: false,
    seller: pickString((item as { seller?: unknown }).seller),
    raw: JSON.stringify(item),
    syncedAt
  }
}

function pickFabImageUrl(item: FabLibraryItem): string | undefined {
  if (!item.images || item.images.length === 0) return undefined
  return item.images[0]?.url
}

function deriveFabProductUrl(item: FabLibraryItem): string | null {
  // The marketplace listing id comes from customAttributes.ListingIdentifier
  // first, falling back to the trailing path segment of `item.url`.
  if (item.customAttributes) {
    for (const attr of item.customAttributes) {
      if (attr.ListingIdentifier) {
        return `https://www.fab.com/listings/${attr.ListingIdentifier}`
      }
    }
  }
  if (item.url) {
    const tail = item.url.split('/').filter((s) => s.length > 0).pop()
    if (tail) return `https://www.fab.com/listings/${tail}`
  }
  return null
}

function pickThumbnailUrl(images: CatalogItem['keyImages']): string | undefined {
  if (!images || images.length === 0) return undefined
  const thumb = images.find((img) => img.type === 'Thumbnail')
  return (thumb ?? images[0]).url
}

/**
 * Persist a non-UE Fab listing (Blender / Maya / FBX / Unity / etc.).
 * Uses `listing.uid` as `sourceId` so it shares the same `source = 'fab'`
 * namespace as the UE library. The description is taken from the first
 * format's `technicalDetails`; the thumbnail is the largest sub-500px
 * image in the thumbnails array (fallback to the first available image).
 */
export function normalizeFabOtherAsset(
  listing: FabOtherListing,
  syncedAt: number
): AssetRow {
  return {
    source: 'fab',
    sourceId: listing.uid,
    subSource: 'fab-other',
    listingType: listing.listingType ? listing.listingType.toLowerCase() : null,
    title: listing.title,
    description: pickFabOtherDescription(listing) ?? listing.description ?? null,
    imageUrl: pickFabOtherImageUrl(listing) ?? null,
    productUrl: `https://www.fab.com/listings/${listing.uid}`,
    ownedAt: null,
    hidden: false,
    bookmarked: false,
    seller: pickString(listing.publisher?.sellerName),
    raw: JSON.stringify(listing),
    syncedAt
  }
}

/** Skip listings that include the `unreal-engine` format — they are already
 * covered by `/e/accounts/.../ue/library` and would otherwise be duplicated. */
export function isUnrealEngineListing(listing: FabOtherListing): boolean {
  if (!listing.assetFormats) return false
  return listing.assetFormats.some(
    (f) => f.assetFormatType?.code === 'unreal-engine'
  )
}

function pickFabOtherImageUrl(listing: FabOtherListing): string | undefined {
  if (!listing.thumbnails || listing.thumbnails.length === 0) return undefined
  let best: { url: string; width: number } | undefined
  for (const thumb of listing.thumbnails) {
    if (!thumb.images) continue
    for (const img of thumb.images) {
      if (img.width >= 500) continue
      if (!best || img.width > best.width) best = img
    }
  }
  if (best) return best.url
  // Fallback to the first image we can find, regardless of width.
  for (const thumb of listing.thumbnails) {
    if (thumb.images && thumb.images[0]?.url) return thumb.images[0].url
    if (thumb.mediaUrl) return thumb.mediaUrl
  }
  return undefined
}

function pickFabOtherDescription(listing: FabOtherListing): string | undefined {
  if (!listing.assetFormats) return undefined
  for (const fmt of listing.assetFormats) {
    if (fmt.technicalSpecs?.technicalDetails) {
      return fmt.technicalSpecs.technicalDetails
    }
  }
  return undefined
}

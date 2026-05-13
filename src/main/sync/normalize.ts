import type { AssetRow } from '../db/assets-repo'
import type { CatalogItem, VaultAssetSummary } from '../vault/vault-client'
import type { FabLibraryItem, FabOtherListing } from '../fab/fab-client'

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
    title,
    description,
    imageUrl,
    productUrl: null,
    ownedAt: ownedAt !== null && Number.isFinite(ownedAt) ? ownedAt : null,
    hidden: false,
    raw: JSON.stringify({ summary, catalog }),
    syncedAt
  }
}

export function normalizeFabAsset(item: FabLibraryItem, syncedAt: number): AssetRow {
  return {
    source: 'fab',
    sourceId: item.assetId,
    title: item.title,
    description: item.description ?? null,
    imageUrl: pickFabImageUrl(item) ?? null,
    productUrl: deriveFabProductUrl(item),
    // The Fab library payload does not carry an acquisition timestamp.
    // We keep `ownedAt` null and rely on `syncedAt` for ordering.
    ownedAt: null,
    hidden: false,
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
    title: listing.title,
    description: pickFabOtherDescription(listing) ?? listing.description ?? null,
    imageUrl: pickFabOtherImageUrl(listing) ?? null,
    productUrl: `https://www.fab.com/listings/${listing.uid}`,
    ownedAt: null,
    hidden: false,
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

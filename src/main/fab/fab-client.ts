import { EPIC_USER_AGENT } from '../vault/user-agent'

/**
 * Shape of a single item returned by `GET /e/accounts/{id}/ue/library`.
 *
 * Field names are **camelCase** (Fab platform style), NOT snake_case.
 * Earlier snake_case spellings (`asset_id`, `thumbnail_url`,
 * `legacy_item_id`, `acquired_at`) were guesses that caused every item
 * to insert with `source_id = NULL`.
 */
export interface FabLibraryItem {
  assetId: string
  title: string
  description?: string
  /** Image collection — we pick `images[0].url` as the thumbnail. */
  images?: Array<{ url: string; type?: string }>
  /** "CODE_PLUGIN" | "ASSET_PACK" | "COMPLETE_PROJECT" | "ENGINE" | … */
  distributionMethod?: string
  assetNamespace?: string
  /** Legacy UE marketplace item id when this asset migrated from there. */
  legacyItemId?: string | null
  /** Carries the Fab marketplace listing id under `ListingIdentifier`. */
  customAttributes?: Array<{ ListingIdentifier?: string; [k: string]: unknown }>
  /** Fab listing URL — fallback source for the listing id. */
  url?: string
  projectVersions?: Array<{
    artifactId: string
    engineVersions?: string[]
    buildVersions?: unknown[]
    assetNamespace?: string
  }>
  categories?: Array<{ name?: string; id?: string }>
  [key: string]: unknown
}

export interface FabLibraryPage {
  results: FabLibraryItem[]
  cursors: { next: string | null }
}

/**
 * One `/i/library/search?source=acquired` result: the acquisition envelope
 * around a listing. Note the envelope `uid` is the entitlement id; the Fab
 * listing uid (join key with the UE library) is `listing.uid`.
 */
export interface FabEntitlementResult {
  /** Acquisition timestamp (ISO, microsecond precision). */
  createdAt?: string
  entitlement?: { licenses?: Array<{ slug?: string; name?: string }> }
  listing?: { uid?: string; lastUpdatedAt?: string | null; [k: string]: unknown }
  [k: string]: unknown
}

/** `/i/library/search` paginates via an absolute `next` URL (null on the last page). */
export interface FabEntitlementPage {
  results: FabEntitlementResult[]
  next: string | null
}

const FAB_PAGE_SIZE = 100

/**
 * Shape of the response from `GET /i/listings/<uid>` (the Fab "listing
 * detail" endpoint — public, no auth, but Cloudflare-gated). Only the
 * fields ReHoarder actually consumes are declared; everything else is
 * captured via `[key: string]: unknown`.
 *
 * Critically: the response carries TWO separate media-bearing arrays:
 *   - `thumbnails[]` (type `"thumbnail"`) — the dedicated featured image
 *     the listing page and Fab search results render as the "main" preview.
 *     Usually exactly one entry. ReHoarder's `pickListingImageUrl` prefers
 *     this.
 *   - `medias[]` (type `"image"` for gallery items, `"video"` for clips) —
 *     the gallery slots shown on the listing page below the featured image.
 *     Each has a `position` field reflecting display order. Used as fallback
 *     when `thumbnails[]` is missing.
 *
 * Both arrays nest `images[]` with multiple resized variants per slot
 * (144 / 160 / 320 / 640 / 960 / 1280 widths typical). The picker takes
 * the widest available — Fab serves them straight from the CDN.
 */
export interface FabListingDetail {
  /** When present, the listing isn't a normal asset (e.g. "Mature" content
   *  hidden by Fab). Caller should treat as "skip" / surface to user. */
  detail?: string
  description?: string
  isAiGenerated?: boolean
  ratings?: { total?: number; averageRating?: number }
  thumbnails?: Array<FabListingMediaBlock>
  medias?: Array<FabListingMediaBlock>
  [k: string]: unknown
}

export interface FabListingMediaBlock {
  /** `"thumbnail"` for entries under top-level `thumbnails[]`, `"image"`
   *  or `"video"` for entries under `medias[]`. */
  type?: 'thumbnail' | 'image' | 'video' | string
  /** Resized variants (different `width` × `height` pairs). The original /
   *  unscaled file is `mediaUrl` instead. */
  images?: Array<{ url: string; width?: number; height?: number }>
  /** Original asset URL (full-size). May be a PNG even when the resized
   *  variants are JPG. */
  mediaUrl?: string
  /** Render order of gallery items (0 = first). Always `null` for thumbnails. */
  position?: number | null
}

export class FabClient {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  /**
   * Fetch the live listing detail for a single Fab uid. Unlike the library
   * endpoint (which can serve cached snapshots with stale `images[0].url`
   * for hours after a creator edits the listing), this endpoint returns
   * the current authoritative data — the same payload the public listing
   * page on fab.com uses. Public, no Authorization / Cookie header required,
   * but still subject to Cloudflare (so callers should route through the
   * `electron.net.fetch` adapter on the `cf-warmup` partition).
   *
   * Throws on non-2xx (caller decides whether to retry or skip).
   */
  async fetchListingDetail(listingUid: string): Promise<FabListingDetail> {
    const url = `https://www.fab.com/i/listings/${encodeURIComponent(listingUid)}?_=${Date.now()}`
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': EPIC_USER_AGENT,
        Accept: 'application/json'
      }
    })
    if (!response.ok) {
      throw new Error(`Fab listing detail returned ${response.status} for ${listingUid}`)
    }
    return (await response.json()) as FabListingDetail
  }

  /**
   * Pick the canonical featured-image URL from a listing-detail payload.
   * Preference order:
   *   1. `thumbnails[0]` — the dedicated featured-image block (type
   *      `"thumbnail"`). This is what Fab uses on its search listings and
   *      as the main preview on the listing page, and is the right choice
   *      for ReHoarder asset cards. Within the block, the widest `images[]`
   *      variant wins; the top-level `mediaUrl` (unscaled original, often
   *      a PNG) is the final fallback.
   *   2. First `medias[]` entry of type `"image"` — the gallery slot at
   *      position 0. Used only when `thumbnails[]` is missing (some older
   *      listings or edge cases). Same widest-variant-then-mediaUrl rule.
   *   3. `null` when nothing usable is recoverable.
   */
  static pickListingImageUrl(detail: FabListingDetail): string | null {
    if (detail.thumbnails && detail.thumbnails.length > 0) {
      const fromThumb = pickFromMediaBlock(detail.thumbnails[0])
      if (fromThumb) return fromThumb
    }
    if (detail.medias) {
      for (const media of detail.medias) {
        if (media.type !== 'image') continue
        const fromGallery = pickFromMediaBlock(media)
        if (fromGallery) return fromGallery
      }
    }
    return null
  }

  async *listLibrary(
    accessToken: string,
    cookieHeader: string,
    accountId: string
  ): AsyncGenerator<FabLibraryPage> {
    // Per-call cache-bust query so any intermediate CDN / proxy along the
    // path is forced to treat each sync as a unique request. Fab ignores
    // unknown query params at the server. Note: Fab's library endpoint can
    // still serve stale data from its own server-side cache (see release
    // notes for 0.2.0 — per-listing detail refresh planned for 0.3.0).
    const cacheBust = String(Date.now())
    let cursor: string | null = null
    do {
      const params = new URLSearchParams({ count: String(FAB_PAGE_SIZE) })
      if (cursor) params.set('cursor', cursor)
      params.set('_', cacheBust)

      const url = `https://www.fab.com/e/accounts/${encodeURIComponent(accountId)}/ue/library?${params}`
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `bearer ${accessToken}`,
          Cookie: cookieHeader,
          'User-Agent': EPIC_USER_AGENT,
          Accept: 'application/json'
        }
      })
      if (!response.ok) {
        throw new Error(`Fab library API returned ${response.status}`)
      }
      const page = (await response.json()) as FabLibraryPage
      yield page
      cursor = page.cursors?.next ?? null
    } while (cursor)
  }
}

/**
 * Pick the best URL from a single Fab media block (a `thumbnails[i]` or
 * `medias[i]` entry). Tries the widest sized variant from `images[]` first;
 * falls back to the unscaled `mediaUrl` (the original PNG / JPG) if no
 * sized variants are listed. Returns `null` when the block carries neither.
 */
function pickFromMediaBlock(block: FabListingMediaBlock): string | null {
  if (block.images && block.images.length > 0) {
    const widest = [...block.images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
    if (widest?.url) return widest.url
  }
  if (block.mediaUrl) return block.mediaUrl
  return null
}

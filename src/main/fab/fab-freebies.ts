import { LAUNCHER_UA } from '../http/user-agents'

/**
 * Single freebie surfaced on Fab's "Free for the Month" homepage blade.
 * Field names are best-effort: the underlying endpoint
 * (`/i/blades/free_content_blade`) is undocumented and uses the Fab
 * frontend's internal listing shape, so unknown fields are tolerated
 * via the `[key: string]` index signature.
 */
export interface FabFreebie {
  /** Fab listing uid: the freebie's identity, matched against the
   *  per-account `freebies.claimedUids` KV set and used for the productUrl
   *  construction. */
  uid: string
  title: string
  /** A representative thumbnail URL when one is known. `null` when nothing
   *  obvious shows up in the response. */
  imageUrl: string | null
  /** Direct deep-link to the listing on fab.com (we open this in the user's
   *  default browser for the actual claim flow). */
  productUrl: string
  /** True iff the user manually marked this freebie as already claimed. Set by
   *  the IPC layer from the per-account `freebies.claimedUids` KV set, never by
   *  the network. Undefined until that resolution runs. */
  claimed?: boolean
  [key: string]: unknown
}

// Use the same `LAUNCHER_UA` that the Fab F1-F5 dance + CF warmup use.
// Cloudflare's `cf_clearance` cookie AND (suspected) Fab's own session
// middleware bind the issued session to the UA that earned them. Mixing
// `EpicGamesLauncher/...` UA on `/me/...` calls leads to a 401 even when
// `fab_sessionid` is present in the request.
const FREEBIE_HEADERS = (cookieHeader: string): Record<string, string> => ({
  Cookie: cookieHeader,
  Referer: 'https://www.fab.com/library',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': LAUNCHER_UA,
  Accept: 'application/json'
})

/**
 * Extract the most likely thumbnail URL from a freebie payload, scanning the
 * three field shapes Fab is known to emit (`thumbnails`, `images`, top-level
 * `imageUrl`). Returns `null` when nothing recognisable is present.
 */
function extractImageUrl(raw: Record<string, unknown>): string | null {
  // `thumbnails[0].mediaUrl` (Fab "Other" library shape)
  const thumbs = raw.thumbnails as
    | Array<{ mediaUrl?: string; images?: Array<{ url?: string }> }>
    | undefined
  if (thumbs && thumbs[0]) {
    if (typeof thumbs[0].mediaUrl === 'string') return thumbs[0].mediaUrl
    const inner = thumbs[0].images?.[0]?.url
    if (typeof inner === 'string') return inner
  }
  // `images[0].url` (Fab UE library shape)
  const images = raw.images as Array<{ url?: string; type?: string }> | undefined
  if (images && images[0]?.url) return images[0].url
  // Tile-style fields (Fab blade tiles wrap things differently)
  if (typeof raw.tile_image === 'string') return raw.tile_image
  if (typeof raw.tile_thumbnail === 'string') return raw.tile_thumbnail
  if (typeof raw.image_url === 'string') return raw.image_url
  if (typeof raw.featured_image === 'string') return raw.featured_image
  // Nested `tile_image.url` / `image.url`
  const tileObj = raw.tile_image as { url?: string } | undefined
  if (tileObj && typeof tileObj.url === 'string') return tileObj.url
  const imgObj = raw.image as { url?: string } | undefined
  if (imgObj && typeof imgObj.url === 'string') return imgObj.url
  // Top-level fallback (some endpoints flatten this)
  if (typeof raw.imageUrl === 'string') return raw.imageUrl
  if (typeof raw.thumbnail === 'string') return raw.thumbnail
  return null
}

/**
 * Read an entry from the response in a way that doesn't assume a single
 * envelope. Fab's blade endpoints have wrapped listings in `results[]`,
 * `tiles[]`, `items[]` and (less often) at the top level in the past;
 * trying a handful of likely keys keeps us resilient to renames.
 */
function pickListings(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return []
  const obj = raw as Record<string, unknown>
  const candidates = ['results', 'tiles', 'items', 'listings', 'data']
  for (const key of candidates) {
    const v = obj[key]
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>
  }
  // The endpoint sometimes nests one level deeper (e.g. `blade.results`).
  const blade = obj.blade
  if (blade && typeof blade === 'object') {
    return pickListings(blade)
  }
  return []
}

export class FabFreebiesClient {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  /**
   * Fetch the current month's freebies. Hits Fab's internal blade endpoint;
   * Cloudflare clearance + a logged-in Fab session cookie are both
   * prerequisites — pass the same `cookieHeader` the rest of the Fab client
   * uses.
   */
  async listFreebies(cookieHeader: string): Promise<FabFreebie[]> {
    const bladeUrl = 'https://www.fab.com/i/blades/free_content_blade'
    const response = await this.fetchImpl(bladeUrl, {
      method: 'GET',
      headers: FREEBIE_HEADERS(cookieHeader)
    })
    if (!response.ok) {
      throw new Error(`Fab freebies blade returned ${response.status}`)
    }
    const raw = (await response.json()) as unknown
    const tiles = pickListings(raw)
    const freebies: FabFreebie[] = tiles.map((tile) => {
      // Each tile wraps a `listing` object that carries the real metadata
      // (title, images, slug, …). The tile's own top-level fields are mostly
      // empty placeholders, so we treat `tile.listing` as the primary source
      // and fall back to the wrapper only when it's missing.
      const listing =
        tile.listing && typeof tile.listing === 'object'
          ? (tile.listing as Record<string, unknown>)
          : {}
      const pickStr = (source: Record<string, unknown>, key: string): string | null => {
        const v = source[key]
        return typeof v === 'string' && v.length > 0 ? v : null
      }
      const uid =
        pickStr(listing, 'uid') ??
        pickStr(tile, 'uid') ??
        pickStr(listing, 'listingId') ??
        pickStr(listing, 'listing_id') ??
        pickStr(listing, 'id') ??
        ''
      const title =
        pickStr(listing, 'title') ??
        pickStr(tile, 'title') ??
        pickStr(listing, 'name') ??
        '(untitled freebie)'
      const slug = pickStr(listing, 'slug') ?? pickStr(tile, 'slug') ?? ''
      const productUrl = slug
        ? `https://www.fab.com/listings/${uid}/${slug}`
        : `https://www.fab.com/listings/${uid}`
      const imageUrl = extractImageUrl(listing) ?? extractImageUrl(tile)
      return {
        // Spread the raw tile FIRST so our normalised fields below win.
        // Otherwise tile.uid (which can be a tile-scoped id, not the listing
        // uid) would clobber our properly-resolved uid.
        ...tile,
        uid,
        title,
        imageUrl,
        productUrl
      }
    })

    return freebies
  }
}

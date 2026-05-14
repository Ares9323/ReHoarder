import { EPIC_USER_AGENT } from '../vault/user-agent'

/**
 * Single freebie surfaced on Fab's "Free for the Month" homepage blade.
 * Field names are best-effort: the underlying endpoint
 * (`/i/blades/free_content_blade`) is undocumented and uses the Fab
 * frontend's internal listing shape, so unknown fields are tolerated
 * via the `[key: string]` index signature.
 */
export interface FabFreebie {
  /** Fab listing uid — primary key for `listings-states` lookups and for the
   *  productUrl construction. */
  uid: string
  title: string
  /** A representative thumbnail URL when one is known. `null` when nothing
   *  obvious shows up in the response. */
  imageUrl: string | null
  /** Direct deep-link to the listing on fab.com (we open this in the user's
   *  default browser for the actual claim flow). */
  productUrl: string
  /** True iff `/i/users/me/listings-states` reports the listing as already
   *  added to the user's library. Undefined while the second call hasn't
   *  resolved (the caller may render a "checking…" pill in the meantime). */
  claimed?: boolean
  [key: string]: unknown
}

interface RawListingState {
  listingId?: string
  uid?: string
  state?: string
  isOwned?: boolean
  owned?: boolean
  isClaimed?: boolean
  [key: string]: unknown
}

const FREEBIE_HEADERS = (cookieHeader: string): Record<string, string> => ({
  Cookie: cookieHeader,
  Referer: 'https://www.fab.com/',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': EPIC_USER_AGENT,
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
 * Pull the `fab_csrftoken` value out of the cookie header so we can echo it
 * back in the `X-CSRFToken` request header — Django enforces double-submit
 * cookie+header for state-affecting routes, and some Fab `/me/` endpoints
 * (notably `listings-states`) reject the request as 401 without it.
 */
function extractCsrfToken(cookieHeader: string): string | null {
  const match = /(?:^|;\s*)fab_csrftoken=([^;]+)/.exec(cookieHeader)
  return match ? decodeURIComponent(match[1]) : null
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
   * uses. The second `listings-states` call enriches each entry with the
   * `claimed` flag; if it fails (e.g. the user isn't signed in to Fab) the
   * freebies still come back, just without claim status.
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
    if (tiles.length > 0) {
      const firstListing =
        tiles[0].listing && typeof tiles[0].listing === 'object'
          ? (tiles[0].listing as Record<string, unknown>)
          : null
      if (firstListing) {
        console.warn('[freebies] first tile.listing keys:', Object.keys(firstListing))
        // Dump candidate id fields so we can confirm which one matches
        // `customAttributes.ListingIdentifier` stored on owned assets.
        const ids = {
          'listing.uid': firstListing.uid,
          'listing.id': firstListing.id,
          'listing.listingId': firstListing.listingId,
          'listing.legacyAssetId': firstListing.legacyAssetId,
          'listing.legacyItemId': firstListing.legacyItemId,
          'tile.uid': tiles[0].uid,
          'tile.url': tiles[0].url
        }
        console.warn('[freebies] candidate id fields:', ids)
      }
    }
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

    // Enrich with claim state. We only call this when we have at least one
    // listing — an empty `listing_ids` query just wastes a round-trip.
    if (freebies.length === 0) return freebies
    try {
      const stateMap = await this.fetchListingStates(
        cookieHeader,
        freebies.map((f) => f.uid).filter((u) => u !== '')
      )
      for (const f of freebies) {
        const st = stateMap.get(f.uid)
        if (st !== undefined) f.claimed = st
      }
    } catch (err) {
      // Non-fatal — keep the list, just without claim flags.
      console.warn('[freebies] listings-states enrichment failed:', err)
    }
    return freebies
  }

  /**
   * Fetch claim state for a batch of listing ids. Returns a Map keyed by
   * listing uid → `true` when the user already owns the listing.
   */
  async fetchListingStates(
    cookieHeader: string,
    listingIds: string[]
  ): Promise<Map<string, boolean>> {
    if (listingIds.length === 0) return new Map()
    const params = new URLSearchParams()
    for (const id of listingIds) params.append('listing_ids', id)
    const url = `https://www.fab.com/i/users/me/listings-states?${params}`
    const headers: Record<string, string> = FREEBIE_HEADERS(cookieHeader)
    const csrf = extractCsrfToken(cookieHeader)
    if (csrf) headers['X-CSRFToken'] = csrf
    const response = await this.fetchImpl(url, { method: 'GET', headers })
    if (!response.ok) {
      // Dump the body to make 401/403 diagnoses concrete — Fab's `/me/`
      // endpoints often respond with a JSON error payload that tells us
      // exactly why (CSRF missing, session expired, anon user, etc.).
      let body = ''
      try {
        body = (await response.text()).slice(0, 300)
      } catch {
        /* ignore */
      }
      throw new Error(
        `Fab listings-states returned ${response.status}${body ? `: ${body}` : ''}`
      )
    }
    const raw = (await response.json()) as unknown
    const out = new Map<string, boolean>()
    // Two shapes seen in the wild:
    //   1. `{ results: [{ listingId, state: "owned" }, ...] }`
    //   2. `{ <uid>: { isOwned: true }, ... }` — keyed object
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>
      const results = pickListings(obj) as RawListingState[]
      if (results.length > 0) {
        for (const r of results) {
          const id = r.listingId ?? r.uid
          if (typeof id !== 'string') continue
          out.set(id, isOwnedFlag(r))
        }
        return out
      }
      // Fallback to the object-keyed shape.
      for (const [key, val] of Object.entries(obj)) {
        if (val && typeof val === 'object') {
          out.set(key, isOwnedFlag(val as RawListingState))
        }
      }
    }
    return out
  }
}

function isOwnedFlag(r: RawListingState): boolean {
  if (typeof r.isOwned === 'boolean') return r.isOwned
  if (typeof r.owned === 'boolean') return r.owned
  if (typeof r.isClaimed === 'boolean') return r.isClaimed
  if (typeof r.state === 'string') {
    return ['owned', 'claimed', 'acquired'].includes(r.state.toLowerCase())
  }
  return false
}

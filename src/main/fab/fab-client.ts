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
 * Shape of a single `result.listing` returned by `/i/library/search`.
 * This is the "Other" Fab library (non-UE assets — Blender, Maya, FBX,
 * MetaHuman, Unity, texture sets, etc.).
 */
export interface FabOtherListing {
  /** Primary identifier for the listing (used as sourceId in the DB). */
  uid: string
  title: string
  listingType?: string
  description?: string
  assetFormats?: Array<{
    assetFormatType: { code: string; name: string }
    technicalSpecs?: { technicalDetails?: string }
  }>
  thumbnails?: Array<{
    mediaUrl?: string
    images?: Array<{ url: string; width: number }>
  }>
  publisher?: { sellerName?: string; uid?: string }
  [k: string]: unknown
}

export interface FabOtherLibraryResult {
  listing: FabOtherListing
  [k: string]: unknown
}

/**
 * `/i/library/search` paginates via an absolute `next` URL, not via a cursor.
 * `next` is a fully-qualified URL or `null` when the last page is reached.
 */
export interface FabOtherLibraryPage {
  results: FabOtherLibraryResult[]
  next: string | null
}

/**
 * Asset formats the Other library search filters on — everything that is
 * NOT plain Unreal Engine assets.
 */
const FAB_OTHER_ASSET_FORMATS = [
  '3ds-max',
  'blender',
  'cinema-4d',
  'converted-files',
  'fbx',
  'glb',
  'gltf',
  'maya',
  'metahuman',
  'obj',
  'texture-set',
  'uefn',
  'unity',
  'usd',
  'usdz',
  'z-brush'
]

const FAB_PAGE_SIZE = 100

export class FabClient {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async *listLibrary(
    accessToken: string,
    cookieHeader: string,
    accountId: string
  ): AsyncGenerator<FabLibraryPage> {
    let cursor: string | null = null
    do {
      const params = new URLSearchParams({ count: String(FAB_PAGE_SIZE) })
      if (cursor) params.set('cursor', cursor)

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

  /**
   * Iterates `https://www.fab.com/i/library/search` with `source=acquired`
   * and the full set of non-UE asset formats. Yields every page until the
   * server stops emitting a `next` URL.
   *
   * Note: `/i/*` is the internal frontend API (less stable than `/e/*`).
   * Auth is cookie-based; the Bearer token is NOT required here.
   */
  async *listOtherLibrary(cookieHeader: string): AsyncGenerator<FabOtherLibraryPage> {
    const params = new URLSearchParams()
    params.set('sort_by', '-createdAt')
    params.set('source', 'acquired')
    for (const fmt of FAB_OTHER_ASSET_FORMATS) {
      params.append('asset_formats', fmt)
    }
    let url: string | null = `https://www.fab.com/i/library/search?${params}`
    while (url !== null) {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Cookie: cookieHeader,
          Referer: 'https://www.fab.com/library',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': EPIC_USER_AGENT,
          Accept: 'application/json'
        }
      })
      if (response.status === 204) return
      if (!response.ok) {
        throw new Error(`Fab Other library API returned ${response.status}`)
      }
      const page = (await response.json()) as FabOtherLibraryPage
      yield page
      url = page.next ?? null
    }
  }
}
